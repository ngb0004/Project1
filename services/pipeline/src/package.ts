import { mkdir, readdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { validateCase, type Issue } from '@sia/case-schema';
import { submitCasePackage, type Db, type VersionRef } from '@sia/case-store';
import { checkCitations, type CitationFailure } from './factcheck';
import type { PipelinePackage } from './orchestrator';
import { MemoryResearchLog, type SnapshotRecord } from './research/log';
import { SourceStore } from './research/store';
import type { JobAudit } from './verify';

/**
 * The package writer: a directory for offline runs, or the review queue through
 * case-store's submitCasePackage (the single import path, which validates the
 * case and lands it as in_review).
 *
 * Directory layout:
 *   case.json                  the case with its review record
 *   review.json                the review record alone
 *   outline.json               the scoper's outline (or the base case's)
 *   research-log-summary.json  counts per agent, scope, round and kind, plus every page opened
 *   manifest.json              run id, cost, rounds, open issues
 *   research-log.jsonl         every query, open, claim and note (written during the run by FileResearchLog)
 *   snapshots/<id>.json        the text of every page opened, as fetched
 */

export const PACKAGE_FILES = {
  case: 'case.json',
  review: 'review.json',
  outline: 'outline.json',
  researchLog: 'research-log-summary.json',
  manifest: 'manifest.json',
  snapshots: 'snapshots',
} as const;

export interface PackageManifest {
  run_id: string;
  request: PipelinePackage['request'];
  written_at: string;
  slug: string;
  title: string;
  as_of: string;
  rounds: number;
  clean: boolean;
  editor_fallback: boolean;
  cost_usd: number;
  steps: number;
  sources: number;
  sources_opened: number;
  open_issues: number;
  research_log_rows: number;
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

export function manifestOf(pkg: PipelinePackage): PackageManifest {
  return {
    run_id: pkg.runId,
    request: pkg.request,
    written_at: new Date().toISOString(),
    slug: pkg.case.slug,
    title: pkg.case.title,
    as_of: pkg.case.as_of,
    rounds: pkg.rounds,
    clean: pkg.clean,
    editor_fallback: pkg.editorFallback,
    cost_usd: Math.round(pkg.costUsd * 10000) / 10000,
    steps: pkg.case.steps.length,
    sources: pkg.case.sources.length,
    sources_opened: pkg.researchLog.opened.length,
    open_issues: pkg.review.open_issues.length,
    research_log_rows: pkg.researchLog.total,
  };
}

/**
 * Writes the package files to `dir`. With `store`, also writes any snapshot the
 * directory does not have yet (a FileResearchLog in the same directory has
 * already written them during the run).
 */
export async function writePackageToDir(pkg: PipelinePackage, dir: string, opts: { store?: SourceStore } = {}): Promise<{ dir: string; files: string[] }> {
  await mkdir(join(dir, PACKAGE_FILES.snapshots), { recursive: true });
  const files: string[] = [];
  const put = async (name: string, value: unknown) => {
    await writeFile(join(dir, name), json(value));
    files.push(name);
  };
  await put(PACKAGE_FILES.case, pkg.case);
  await put(PACKAGE_FILES.review, pkg.review);
  await put(PACKAGE_FILES.outline, pkg.outline);
  await put(PACKAGE_FILES.researchLog, pkg.researchLog);
  await put(PACKAGE_FILES.manifest, manifestOf(pkg));
  for (const s of opts.store?.opened() ?? []) {
    const name = join(PACKAGE_FILES.snapshots, `${s.id}.json`);
    if (await exists(join(dir, name))) continue;
    const record: SnapshotRecord = {
      id: s.id,
      url: s.url,
      final_url: s.finalUrl,
      http_status: s.status,
      content_type: s.contentType,
      title: s.title,
      sha256: s.sha256,
      text_content: s.text,
      fetched_at: s.fetchedAt,
    };
    await writeFile(join(dir, name), json(record));
    files.push(name);
  }
  return { dir, files };
}

/** Reads every snapshot file (`<id>.json`) in a directory. */
export async function readSnapshotDir(dir: string): Promise<SnapshotRecord[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  const out: SnapshotRecord[] = [];
  for (const n of names) {
    const r = JSON.parse(await readFile(join(dir, n), 'utf8')) as Partial<SnapshotRecord>;
    if (typeof r.id !== 'string' || typeof r.url !== 'string' || typeof r.text_content !== 'string') continue;
    out.push({
      id: r.id,
      url: r.url,
      final_url: r.final_url ?? r.url,
      http_status: Number(r.http_status ?? 0),
      content_type: r.content_type ?? '',
      title: r.title ?? '',
      sha256: r.sha256 ?? '',
      text_content: r.text_content,
      fetched_at: r.fetched_at ?? '',
    });
  }
  return out;
}

export interface SavedPackageCheck {
  ok: boolean;
  schemaErrors: Issue[];
  failures: CitationFailure[];
  snapshots: number;
}

/** `pipeline check`: validates a saved case and re-runs the citation check against saved snapshots. */
export async function checkSavedPackage(casePath: string, snapshotDir: string): Promise<SavedPackageCheck> {
  const raw = JSON.parse(await readFile(casePath, 'utf8')) as unknown;
  const v = validateCase(raw);
  const store = new SourceStore({ log: new MemoryResearchLog() });
  const records = await readSnapshotDir(snapshotDir);
  store.load(records);
  const failures = checkCitations((v.case ?? raw) as Parameters<typeof checkCitations>[0], store);
  return { ok: v.ok && failures.length === 0, schemaErrors: v.errors, failures, snapshots: store.opened().length };
}

/**
 * Saves what `pipeline verify` read back from the database: the case, its review
 * record, the job, the audit, the research log (JSONL) and every snapshot.
 */
export async function writeAuditDir(audit: JobAudit, dir: string): Promise<void> {
  await mkdir(join(dir, PACKAGE_FILES.snapshots), { recursive: true });
  const { doc, logRows, snapshots, job, ...rest } = audit;
  if (doc) {
    await writeFile(join(dir, PACKAGE_FILES.case), json(doc));
    await writeFile(join(dir, PACKAGE_FILES.review), json(doc.review));
  }
  await writeFile(join(dir, 'job.json'), json(job));
  await writeFile(join(dir, 'audit.json'), json(rest));
  await writeFile(join(dir, 'research-log.jsonl'), logRows.map((r) => JSON.stringify(r)).join('\n') + (logRows.length ? '\n' : ''));
  for (const s of snapshots) await writeFile(join(dir, PACKAGE_FILES.snapshots, `${s.id}.json`), json(s));
}

export interface SubmitOptions {
  jobId?: string | null;
  /** The version a revision or update is based on. */
  basedOnVersion?: number | null;
  tags?: string[];
}

/** Lands the package in the review queue as the signed-in pipeline account. */
export async function submitPackage(db: Db, pkg: PipelinePackage, opts: SubmitOptions = {}): Promise<VersionRef> {
  return submitCasePackage(db, {
    slug: pkg.case.slug,
    doc: pkg.case,
    jobId: opts.jobId ?? null,
    basedOnVersion: opts.basedOnVersion ?? null,
    tags: opts.tags ?? [],
    origin: 'pipeline',
  });
}
