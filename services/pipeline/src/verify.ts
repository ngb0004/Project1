import { createHash } from 'node:crypto';
import { validateCase, type Case, type Issue } from '@sia/case-schema';
import {
  getPipelineJob,
  getSourceSnapshot,
  getStaffVersion,
  listQueue,
  listResearchLog,
  listSnapshotMeta,
  type Db,
  type PipelineJobRow,
  type ResearchLogRow,
  type SourceSnapshotMeta,
} from '@sia/case-store';
import { archiveFor } from './archive';
import { checkCitations, type CitationFailure } from './factcheck';
import { PIPELINE_LOG_AGENT, RECORDS_SCOPE } from './orchestrator';
import { MemoryResearchLog, type LogKind, type SnapshotRecord } from './research/log';
import { SourceStore } from './research/store';
import { urlKey } from './research/text';

/**
 * Audits one finished pipeline job from the database alone, as any staff
 * account (the pipeline account can read what it wrote): the package it
 * submitted, the snapshots of every page it opened and its research log. It
 * re-runs the schema validator and the citation check against the stored
 * snapshots, so it proves the package without trusting the run that made it.
 *
 * `pipeline verify <job-id> [--out <dir>]` prints the checks and can save the
 * whole package (case, review, job, research log, snapshots) to a directory.
 */

export interface AuditCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SourceAudit {
  id: string;
  url: string;
  /** The job's snapshot of this URL (requested or final URL), if any. */
  snapshot_id: string | null;
  http_status: number | null;
  /** Revisions and updates: an earlier job's snapshot of it, from the version this one is based on. */
  archived_snapshot_id?: string;
}

export type KindCounts = Partial<Record<LogKind, number>>;

export interface JobAudit {
  ok: boolean;
  checks: AuditCheck[];
  job: PipelineJobRow;
  caseId?: string;
  version?: number;
  versionStatus?: string;
  doc?: Case;
  schemaErrors: Issue[];
  schemaWarnings: Issue[];
  citationFailures: CitationFailure[];
  /** Evidence quotes and quote layers checked against the stored snapshots. */
  quotesChecked: number;
  sources: SourceAudit[];
  /** Log rows per agent and kind, and per agent/scope for the research agents. */
  logByAgent: Record<string, KindCounts>;
  logByScope: Record<string, KindCounts>;
  logRows: ResearchLogRow[];
  snapshots: SnapshotRecord[];
}

/** Agents that search, open and log claims. */
export const RESEARCH_AGENTS = ['scoper', 'researcher', 'records_researcher'] as const;
export const ALL_AGENTS = ['scoper', 'researcher', 'records_researcher', 'drafter', 'hard_questions', 'red_team', 'fact_checker', 'editor'] as const;

function count(rows: ResearchLogRow[], key: (r: ResearchLogRow) => string): Record<string, KindCounts> {
  const out: Record<string, KindCounts> = {};
  for (const r of rows) {
    const k = key(r);
    const c = (out[k] ??= {});
    c[r.kind] = (c[r.kind] ?? 0) + 1;
  }
  return out;
}

function quoteCount(c: Case): number {
  let n = 0;
  for (const f of c.starting_facts) n += f.evidence?.length ?? 0;
  for (const s of c.steps) {
    n += s.evidence?.length ?? 0;
    n += s.depth.filter((l) => l.kind === 'quote').length;
  }
  for (const e of c.timeline ?? []) n += e.evidence?.length ?? 0;
  for (const t of c.takes ?? []) for (const ch of t.checks ?? []) n += ch.evidence?.length ?? 0;
  return n;
}

async function loadSnapshots(db: Db, metas: SourceSnapshotMeta[]): Promise<SnapshotRecord[]> {
  const out: SnapshotRecord[] = [];
  for (const m of metas) {
    const row = await getSourceSnapshot(db, m.id);
    if (!row) continue;
    out.push({
      id: row.id,
      url: row.url,
      final_url: row.final_url ?? row.url,
      http_status: row.http_status ?? 0,
      content_type: row.content_type ?? '',
      title: row.title ?? '',
      sha256: row.sha256,
      text_content: row.text_content,
      fetched_at: row.fetched_at,
    });
  }
  return out;
}

export async function verifyJob(db: Db, jobId: string): Promise<JobAudit> {
  const job = await getPipelineJob(db, jobId);
  if (!job) throw new Error(`job ${jobId} was not found (or this account cannot read it)`);
  const checks: AuditCheck[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  check('job succeeded', job.status === 'succeeded', `status ${job.status}${job.error ? `: ${job.error}` : ''}`);

  const [logRows, metas] = await Promise.all([listResearchLog(db, jobId), listSnapshotMeta(db, jobId)]);
  const snapshots = await loadSnapshots(db, metas);
  const store = new SourceStore({ log: new MemoryResearchLog() });
  store.load(snapshots);

  const caseId = typeof job.result?.case_id === 'string' ? job.result.case_id : undefined;
  const version = typeof job.result?.version === 'number' ? job.result.version : undefined;
  const row = caseId && version !== undefined ? await getStaffVersion(db, caseId, version) : null;
  const doc = row?.doc;
  let schemaErrors: Issue[] = [];
  let schemaWarnings: Issue[] = [];
  let citationFailures: CitationFailure[] = [];
  const sources: SourceAudit[] = [];
  let quotesChecked = 0;

  if (!row || !doc) {
    check('package in the review queue', false, `no case version recorded for the job (result: ${JSON.stringify(job.result)})`);
  } else {
    const queue = await listQueue(db);
    const queued = queue.some((q) => q.case_id === caseId && q.version === version);
    check('package in the review queue', row.status === 'in_review' && queued && row.pipeline_job_id === jobId, `version ${version} is ${row.status}${queued ? ' and in staff_queue' : ', not in staff_queue'}`);

    const v = validateCase(doc);
    schemaErrors = v.errors;
    schemaWarnings = v.warnings;
    check('schema-valid', v.errors.length === 0, `${v.errors.length} errors, ${v.warnings.length} warnings`);

    // A revision or update also has the archive: the snapshots earlier jobs took of the sources of the version it
    // is based on. They back facts it left unchanged when a page changed since (src/archive.ts).
    const archive = job.kind !== 'new_case' && caseId && row.based_on_version !== null ? await archiveFor(db, caseId, row.based_on_version, doc) : null;
    if (archive) {
      store.archive(archive.snapshots);
      // Saved with the job's own snapshots, so `pipeline check` on a saved audit reads the same evidence.
      snapshots.push(...archive.snapshots.filter((a) => !snapshots.some((x) => x.id === a.id)));
    }

    for (const s of doc.sources) {
      const key = urlKey(s.url);
      const usable = metas.filter((m) => (urlKey(m.url) === key || (m.final_url && urlKey(m.final_url) === key)) && m.http_status === 200);
      const snap = usable[0] ?? metas.find((m) => urlKey(m.url) === key || (m.final_url && urlKey(m.final_url) === key));
      const archived = archive?.snapshots.find((a) => urlKey(a.url) === key || urlKey(a.final_url) === key);
      sources.push({
        id: s.id,
        url: s.url,
        snapshot_id: snap?.id ?? null,
        http_status: snap?.http_status ?? null,
        ...(archived ? { archived_snapshot_id: archived.id } : {}),
      });
    }
    const missing = sources.filter((s) => (s.snapshot_id === null || s.http_status !== 200) && !s.archived_snapshot_id);
    const carried = sources.filter((s) => (s.snapshot_id === null || s.http_status !== 200) && s.archived_snapshot_id);
    check(
      archive?.jobIds.length ? 'every source opened by this job, or archived by the job that cited it' : 'every source opened by this job (HTTP 200 snapshot)',
      missing.length === 0,
      `${sources.length - missing.length - carried.length}/${sources.length} opened by this job` +
        (carried.length ? `; ${carried.length} not usable now but archived: ${carried.map((m) => m.id).join(', ')}` : '') +
        (missing.length ? `; missing: ${missing.map((m) => `${m.id} (${m.url})`).join(', ')}` : ''),
    );

    citationFailures = checkCitations(doc, store);
    quotesChecked = quoteCount(doc);
    const flagged = citationFailures.filter((f) => doc.review.open_issues.some((o) => o.description.includes(f.target)));
    check(
      'every quote verbatim in its snapshot',
      citationFailures.length === 0,
      `${quotesChecked} quotes checked; ${citationFailures.length} failures` +
        (citationFailures.length ? ` (${flagged.length} flagged as open issues): ${citationFailures.map((f) => `${f.target} ${f.verdict}`).join(', ')}` : ''),
    );

    const r = doc.review;
    const sideIds = doc.sides.map((s) => s.id);
    const reported = new Set(r.bias_reports.map((b) => b.side_id));
    check('review: hard questions', r.hard_questions.length > 0, `${r.hard_questions.length} (${r.hard_questions.filter((q) => q.resolution).length} with a resolution)`);
    check('review: a bias report for every side', sideIds.every((id) => reported.has(id)), `${r.bias_reports.length} reports; sides without one: ${sideIds.filter((id) => !reported.has(id)).join(', ') || 'none'}`);
    check('review: fact-check table', r.fact_check.length > 0, `${r.fact_check.length} rows`);
    check('review: balance summary', !!r.balance, r.balance ? JSON.stringify(r.balance.per_side) : 'missing');
    check('review: open issues listed', Array.isArray(r.open_issues), `${r.open_issues.length} open issues`);
  }

  // Research log: every opened page has its snapshot; every research agent searched, opened and logged claims; every agent ran.
  // The snapshots are what the citation check above read: each stored text must still hash to its sha256.
  const tampered = snapshots.filter((x) => createHash('sha256').update(x.text_content).digest('hex') !== x.sha256);
  check('every snapshot matches its sha256', tampered.length === 0, `${snapshots.length - tampered.length}/${snapshots.length}${tampered.length ? `; mismatched: ${tampered.map((x) => x.id).join(', ')}` : ''}`);

  const snapIds = new Set(metas.map((m) => m.id));
  const opens = logRows.filter((x) => x.kind === 'open');
  const orphanOpens = opens.filter((x) => x.snapshot_id && !snapIds.has(x.snapshot_id));
  check('every logged open with a snapshot has its snapshot row', orphanOpens.length === 0, `${opens.length} opens (${opens.filter((x) => x.snapshot_id).length} usable), ${snapshots.length} snapshots`);
  const logByAgent = count(logRows, (x) => x.agent);
  const logByScope = count(
    logRows.filter((x) => (RESEARCH_AGENTS as readonly string[]).includes(x.agent)),
    (x) => `${x.agent}${x.scope ? `#${x.scope}` : ''}`,
  );
  // A new case must show each research agent searching and opening pages, and each researcher logging claims.
  // Revisions and updates skip the scoper and may find nothing new, so they only need each researcher's search.
  const fresh = job.kind === 'new_case';
  const expected = doc
    ? [...(fresh ? ['scoper'] : []), ...doc.sides.map((s) => `researcher#${s.id}`), `records_researcher#${RECORDS_SCOPE}`]
    : [];
  const gaps = expected.flatMap((k) => {
    const c = logByScope[k] ?? {};
    const need: LogKind[] = fresh ? (k === 'scoper' ? ['query', 'open'] : ['query', 'open', 'claim']) : ['query'];
    const lacking = need.filter((kind) => !c[kind]);
    return lacking.length ? [`${k} (no ${lacking.join('/')})`] : [];
  });
  check(
    'research agents logged queries, opens and claims',
    !!doc && gaps.length === 0,
    `${Object.entries(logByScope).map(([k, c]) => `${k}: ${c.query ?? 0}q/${c.open ?? 0}o/${c.claim ?? 0}c`).join(', ')}${gaps.length ? `; missing: ${gaps.join(', ')}` : ''}`,
  );
  const finished = (a: string) => logRows.some((x) => x.agent === a && x.kind === 'note' && x.excerpt?.startsWith('Agent call finished'));
  // Revisions and updates take their outline from the existing case: no scoper call.
  const agents = fresh ? ALL_AGENTS : ALL_AGENTS.filter((a) => a !== 'scoper');
  const silent = agents.filter((a) => !finished(a));
  check('every agent ran and logged its call', silent.length === 0, silent.length ? `no finished call from: ${silent.join(', ')}` : `${agents.length} agents; plus ${logByAgent[PIPELINE_LOG_AGENT]?.note ?? 0} pipeline notes`);

  return {
    ok: checks.every((c) => c.ok),
    checks,
    job,
    ...(caseId ? { caseId } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(row ? { versionStatus: row.status } : {}),
    ...(doc ? { doc } : {}),
    schemaErrors,
    schemaWarnings,
    citationFailures,
    quotesChecked,
    sources,
    logByAgent,
    logByScope,
    logRows,
    snapshots,
  };
}
