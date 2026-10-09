import type { Case, CaseInput } from '@sia/case-schema';
import { getSourceSnapshot, listSnapshotMeta, type Db } from '@sia/case-store';
import type { DraftCase } from './agents/shared';
import type { SnapshotRecord } from './research/log';
import type { Snapshot, SourceStore } from './research/store';
import { matchQuote, urlKey } from './research/text';

/**
 * The evidence archive for revisions and updates.
 *
 * A published version was checked against snapshots its own job took. When a
 * later revision or update re-opens those sources, a page may have changed: a
 * paywall, a removed article, an edited story. The facts the new version leaves
 * unchanged were still verified against what the page said when it was cited,
 * so the run loads those earlier snapshots (`archiveFor`) as fallback evidence
 * (`SourceStore.archive`), and `sourceDrift` reports every source that no
 * longer says what the case quotes, for the admin.
 */

export type ArchivedSnapshot = SnapshotRecord & { job_id: string };

/** The pipeline jobs behind a version and the versions it was derived from (based_on chain), newest first. */
export async function archiveJobIds(db: Db, caseId: string, version: number | null, maxDepth = 8): Promise<string[]> {
  const jobs: string[] = [];
  const seen = new Set<number>();
  let v = version;
  for (let depth = 0; v !== null && depth < maxDepth && !seen.has(v); depth++) {
    seen.add(v);
    const { data, error } = await db
      .from('staff_case_versions')
      .select('pipeline_job_id, based_on_version')
      .eq('case_id', caseId)
      .eq('version', v)
      .limit(1);
    if (error) throw new Error(`could not read version ${v}: ${error.message}`);
    const row = (data as { pipeline_job_id: string | null; based_on_version: number | null }[])[0];
    if (!row) break;
    if (row.pipeline_job_id && !jobs.includes(row.pipeline_job_id)) jobs.push(row.pipeline_job_id);
    v = row.based_on_version;
  }
  return jobs;
}

/** Usable (HTTP 200) snapshots those jobs took of the given URLs (requested or final URL). */
export async function loadArchive(db: Db, jobIds: string[], urls: string[]): Promise<ArchivedSnapshot[]> {
  const wanted = new Set(urls.map(urlKey));
  const out: ArchivedSnapshot[] = [];
  for (const jobId of jobIds) {
    const metas = await listSnapshotMeta(db, jobId);
    for (const m of metas) {
      if (m.http_status !== 200) continue;
      if (!wanted.has(urlKey(m.url)) && !(m.final_url && wanted.has(urlKey(m.final_url)))) continue;
      const row = await getSourceSnapshot(db, m.id);
      if (!row) continue;
      out.push({
        id: row.id,
        job_id: row.job_id,
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
  }
  return out;
}

/** The archive for a version: snapshots of its sources from its own job and the jobs of the versions it came from. */
export async function archiveFor(db: Db, caseId: string, version: number, doc: Pick<Case, 'sources'>): Promise<{ jobIds: string[]; snapshots: ArchivedSnapshot[] }> {
  const jobIds = await archiveJobIds(db, caseId, version);
  return { jobIds, snapshots: await loadArchive(db, jobIds, doc.sources.map((s) => s.url)) };
}

type AnyCase = Case | CaseInput | DraftCase;

/** Every verbatim quote a case takes from each source (evidence and quote layers), by source id. */
export function quotesBySource(c: AnyCase): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (sid: string, q: string) => out.set(sid, [...(out.get(sid) ?? []), q]);
  for (const f of c.starting_facts ?? []) f.evidence?.forEach((e) => add(e.source_id, e.quote));
  for (const s of c.steps ?? []) {
    s.evidence?.forEach((e) => add(e.source_id, e.quote));
    for (const l of s.depth ?? []) if (l.kind === 'quote') add(l.source_id, l.text);
  }
  return out;
}

const hasAll = (snap: Snapshot, quotes: string[]) => quotes.every((q) => matchQuote(q, snap.text).ok);

/**
 * The snapshot the critics should read for a source: the newest one (opened in
 * this run if it was) that still contains every quote the case takes from it,
 * else the newest one.
 */
export function bestSnapshot(store: SourceStore, url: string, quotes: string[]): Snapshot | undefined {
  const all = store.findAllByUrl(url);
  for (let i = all.length - 1; i >= 0; i--) if (hasAll(all[i]!, quotes)) return all[i];
  return all[all.length - 1];
}

export interface SourceDrift {
  source_id: string;
  url: string;
  /** What re-opening it in this run gave: the snapshot, or nothing usable. */
  fresh: { chars: number; status: number } | null;
  quotes: number;
  /** Quotes no longer in the page as opened in this run. */
  missing: number;
  /** The archived snapshot that still has every quote, if one does. */
  archived: { snapshot_id: string; job_id: string; fetched_at: string } | null;
}

/**
 * Sources of `base` that no longer say what the case quotes from them, as
 * opened in this run. Each is backed by an archived snapshot (when one still
 * has every quote) or not, in which case the citation check fails the facts
 * that cite it.
 */
export function sourceDrift(base: AnyCase, store: SourceStore): SourceDrift[] {
  const quotes = quotesBySource(base);
  const out: SourceDrift[] = [];
  for (const s of base.sources ?? []) {
    const qs = quotes.get(s.id) ?? [];
    const all = store.findAllByUrl(s.url);
    const fresh = all.filter((x) => !x.archivedFrom);
    const latest = fresh[fresh.length - 1];
    const missing = latest ? qs.filter((q) => !matchQuote(q, latest.text).ok) : qs;
    if (latest && missing.length === 0) continue;
    // Backed when every passage the fresh page lacks is in an archived snapshot (newest first).
    const archives = all.filter((x) => x.archivedFrom).reverse();
    const covered = archives.length > 0 && missing.every((q) => archives.some((x) => matchQuote(q, x.text).ok));
    const backing = covered ? (archives.find((x) => hasAll(x, missing)) ?? archives[0]) : undefined;
    out.push({
      source_id: s.id,
      url: s.url,
      fresh: latest ? { chars: latest.text.length, status: latest.status } : null,
      quotes: qs.length,
      missing: missing.length,
      archived: backing ? { snapshot_id: backing.id, job_id: backing.archivedFrom!.jobId, fetched_at: backing.fetchedAt } : null,
    });
  }
  return out;
}

/** One plain sentence about a drifted source, for the research log and the admin. */
export function describeDrift(d: SourceDrift, baseVersion: number): string {
  const now = d.fresh
    ? `re-opened in this run it has ${d.fresh.chars.toLocaleString('en-US')} characters of text, and ${d.missing} of the ${d.quotes} passage(s) the case quotes from it are no longer in it`
    : 'it could not be opened in this run';
  const backed = d.archived
    ? ` The facts that cite it are checked against the snapshot taken on ${d.archived.fetched_at.slice(0, 10)} (job ${d.archived.job_id.slice(0, 8)}), which still has the quoted passages; consider replacing the source.`
    : ' No earlier snapshot has every quoted passage either, so the facts that cite it fail the citation check.';
  return `Source "${d.source_id}" (${d.url}) has changed since version ${baseVersion} cited it: ${now}.${backed}`;
}
