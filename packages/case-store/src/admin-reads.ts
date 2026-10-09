import type { CaseStatus, SeedProfile } from '@sia/case-schema';
import { StoreError, type Db } from './index';

/**
 * Typed staff reads used by the admin console: cases, alerts, pipeline jobs,
 * research logs, source snapshots, decisions and user signals. All of them go
 * through the signed-in user's client, so row-level security decides what comes
 * back (staff only; the public sees none of these).
 */

function unwrap<T>(res: { data: T | null; error: { message: string; code?: string; details?: unknown } | null }): T {
  if (res.error) throw new StoreError(res.error.message, res.error.code, res.error.details);
  return res.data as T;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export interface StaffCaseRow {
  id: string;
  slug: string;
  live_version: number | null;
  featured: boolean;
  /** Postgres interval as text, e.g. "1 day" or "06:00:00"; null when updates are off. */
  update_cadence: string | null;
  next_update_at: string | null;
  /** As stored (validated against SeedProfile when it was saved). */
  seed_profile: SeedProfile | null;
  fairness_unfair_threshold: number;
  fairness_min_ratings: number;
  created_at: string;
  created_by: string;
  in_review_count: number;
}

export async function getStaffCase(db: Db, caseId: string): Promise<StaffCaseRow | null> {
  const rows = unwrap(await db.from('staff_cases').select('*').eq('id', caseId).limit(1)) as StaffCaseRow[];
  return rows[0] ?? null;
}

export async function listStaffCases(db: Db): Promise<StaffCaseRow[]> {
  return unwrap(await db.from('staff_cases').select('*').order('created_at', { ascending: false })) as StaffCaseRow[];
}

/** Version summaries (no documents) for many cases at once, e.g. to title the live cases on the queue. */
export interface VersionSummaryRow {
  case_id: string;
  slug: string;
  version: number;
  status: CaseStatus;
  origin: 'pipeline' | 'admin' | 'import';
  tags: string[];
  parent_version: number | null;
  based_on_version: number | null;
  title: string;
  as_of: string;
  created_at: string;
  submitted_at: string | null;
  published_at: string | null;
  scheduled_publish_at: string | null;
  is_live: boolean | null;
}

const VERSION_SUMMARY_COLUMNS =
  'case_id, slug, version, status, origin, tags, parent_version, based_on_version, title, as_of, created_at, submitted_at, published_at, scheduled_publish_at, is_live';

/** Case ids per request: a long `in` list overflows the URL limit (hundreds of cases did). */
const SUMMARY_ID_CHUNK = 100;
/** Rows per page: PostgREST returns at most `max_rows` (1000) rows per request. */
const SUMMARY_PAGE = 1000;

export async function listVersionSummaries(db: Db, caseIds: string[]): Promise<VersionSummaryRow[]> {
  const ids = [...new Set(caseIds)];
  const out: VersionSummaryRow[] = [];
  for (let i = 0; i < ids.length; i += SUMMARY_ID_CHUNK) {
    const chunk = ids.slice(i, i + SUMMARY_ID_CHUNK);
    for (let from = 0; ; from += SUMMARY_PAGE) {
      const rows = unwrap(
        await db
          .from('staff_case_versions')
          .select(VERSION_SUMMARY_COLUMNS)
          .in('case_id', chunk)
          .order('version', { ascending: false })
          .order('case_id')
          .range(from, from + SUMMARY_PAGE - 1),
      ) as VersionSummaryRow[];
      out.push(...rows);
      if (rows.length < SUMMARY_PAGE) break;
    }
  }
  // Newest version first, as one query would have returned them.
  return out.sort((a, b) => b.version - a.version);
}

// ---------------------------------------------------------------------------
// Review alerts (fairness and flag thresholds)
// ---------------------------------------------------------------------------

export interface ReviewAlertRow {
  id: number;
  case_id: string;
  case_version: number;
  kind: 'fairness' | 'flags';
  side_id: string | null;
  step_id: string | null;
  details: Record<string, unknown>;
  pipeline_job_id: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: string | null;
}

export async function listReviewAlerts(
  db: Db,
  opts: { caseId?: string; version?: number; openOnly?: boolean; limit?: number } = {},
): Promise<ReviewAlertRow[]> {
  let q = db.from('review_alerts').select('*');
  if (opts.caseId) q = q.eq('case_id', opts.caseId);
  if (opts.version !== undefined) q = q.eq('case_version', opts.version);
  if (opts.openOnly) q = q.is('resolved_at', null);
  return unwrap(await q.order('created_at', { ascending: false }).limit(opts.limit ?? 200)) as ReviewAlertRow[];
}

/**
 * Marks an open alert resolved. Row-level security allows this only for the
 * admin, and only these three columns are writable.
 */
export async function adminResolveAlert(db: Db, alertId: number, resolution: string, actor: string): Promise<void> {
  const note = resolution.trim();
  if (!note) throw new StoreError('write how the alert was resolved', '22023');
  const rows = unwrap(
    await db
      .from('review_alerts')
      .update({ resolved_at: new Date().toISOString(), resolved_by: actor, resolution: note })
      .eq('id', alertId)
      .is('resolved_at', null)
      .select('id'),
  ) as { id: number }[];
  if (rows.length === 0) throw new StoreError(`alert ${alertId} is not open (or not visible)`, 'PT404');
}

// ---------------------------------------------------------------------------
// Pipeline jobs, research log, source snapshots
// ---------------------------------------------------------------------------

export const PIPELINE_JOB_STATUSES = ['queued', 'running', 'succeeded', 'no_changes', 'failed', 'cancelled'] as const;
export type PipelineJobStatus = (typeof PIPELINE_JOB_STATUSES)[number];

export interface PipelineJobRow {
  id: string;
  kind: 'new_case' | 'revision' | 'update';
  case_id: string | null;
  base_version: number | null;
  brief: string | null;
  instructions: string | null;
  status: PipelineJobStatus;
  attempts: number;
  /** Model spend in USD across all attempts, as the worker last reported it (absent before migration 10). */
  spent_usd?: number | string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  heartbeat_at: string | null;
  finished_at: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  created_by: string;
}

export async function listPipelineJobs(
  db: Db,
  opts: { statuses?: PipelineJobStatus[]; caseId?: string; limit?: number } = {},
): Promise<PipelineJobRow[]> {
  let q = db.from('pipeline_jobs').select('*');
  if (opts.statuses?.length) q = q.in('status', opts.statuses);
  if (opts.caseId) q = q.eq('case_id', opts.caseId);
  return unwrap(await q.order('created_at', { ascending: false }).limit(opts.limit ?? 100)) as PipelineJobRow[];
}

export async function getPipelineJob(db: Db, jobId: string): Promise<PipelineJobRow | null> {
  const rows = unwrap(await db.from('pipeline_jobs').select('*').eq('id', jobId).limit(1)) as PipelineJobRow[];
  return rows[0] ?? null;
}

export type ResearchLogKind = 'query' | 'open' | 'claim' | 'note';

export interface ResearchLogRow {
  id: number;
  job_id: string;
  case_id: string | null;
  agent: string;
  scope: string | null;
  round: number;
  kind: ResearchLogKind;
  query: string | null;
  url: string | null;
  title: string | null;
  snapshot_id: string | null;
  http_status: number | null;
  excerpt: string | null;
  claims: unknown;
  created_at: string;
}

/**
 * PostgREST returns at most `max_rows` rows per request (1,000 on the local
 * stack), whatever `.limit()` asks for. Reads that must be complete page
 * through with `.range()` until a short page comes back.
 */
const PAGE_ROWS = 1000;

async function selectAllPages<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string; code?: string; details?: unknown } | null }>, cap = 200_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < cap; from += PAGE_ROWS) {
    const rows = unwrap(await page(from, from + PAGE_ROWS - 1)) ?? [];
    out.push(...rows);
    if (rows.length < PAGE_ROWS) break;
  }
  return out;
}

/** Every query run, page opened and claim extracted by one pipeline job, in order (all of it, paged). */
export async function listResearchLog(db: Db, jobId: string): Promise<ResearchLogRow[]> {
  return selectAllPages<ResearchLogRow>((from, to) =>
    db.from('research_log').select('*').eq('job_id', jobId).order('id', { ascending: true }).range(from, to),
  );
}

export interface ResearchLogGroup {
  agent: string;
  scope: string | null;
  round: number;
  /** Rows per kind (query, open, claim, note). */
  counts: Record<string, number>;
  total: number;
}

export interface ResearchLogSummary {
  /** Every row the job logged. */
  total: number;
  /** One group per agent, scope and round, in the order the job first logged them. */
  groups: ResearchLogGroup[];
}

/** Counts per agent, scope, round and kind, read in pages of small columns (no text), so the whole log is counted. */
export async function researchLogSummary(db: Db, jobId: string): Promise<ResearchLogSummary> {
  const rows = await selectAllPages<{ agent: string; scope: string | null; round: number; kind: string }>((from, to) =>
    db.from('research_log').select('agent, scope, round, kind').eq('job_id', jobId).order('id', { ascending: true }).range(from, to),
  );
  const groups = new Map<string, ResearchLogGroup>();
  for (const r of rows) {
    const key = `${r.agent}\u0000${r.scope ?? ''}\u0000${r.round}`;
    let g = groups.get(key);
    if (!g) {
      g = { agent: r.agent, scope: r.scope, round: r.round, counts: {}, total: 0 };
      groups.set(key, g);
    }
    g.counts[r.kind] = (g.counts[r.kind] ?? 0) + 1;
    g.total++;
  }
  return { total: rows.length, groups: [...groups.values()] };
}

/** One page of one group of a job's research log, in order. */
export async function listResearchLogPage(
  db: Db,
  jobId: string,
  group: { agent: string; scope: string | null; round: number },
  offset: number,
  limit: number,
): Promise<ResearchLogRow[]> {
  let q = db.from('research_log').select('*').eq('job_id', jobId).eq('agent', group.agent).eq('round', group.round);
  q = group.scope === null ? q.is('scope', null) : q.eq('scope', group.scope);
  return unwrap(await q.order('id', { ascending: true }).range(offset, offset + Math.max(1, limit) - 1)) as ResearchLogRow[];
}

/** Which of `urls` the job logged as opened (kind = 'open'), checked in the database for every URL. */
export async function researchLogOpenedUrls(db: Db, jobId: string, urls: string[]): Promise<Set<string>> {
  const unique = [...new Set(urls.filter(Boolean))];
  const out = new Set<string>();
  for (let i = 0; i < unique.length; i += 40) {
    const chunk = unique.slice(i, i + 40);
    const rows = await selectAllPages<{ url: string | null }>((from, to) =>
      db.from('research_log').select('url').eq('job_id', jobId).eq('kind', 'open').in('url', chunk).range(from, to),
    );
    for (const r of rows) if (r.url) out.add(r.url);
  }
  return out;
}

export interface SourceSnapshotMeta {
  id: string;
  job_id: string;
  url: string;
  final_url: string | null;
  http_status: number | null;
  content_type: string | null;
  title: string | null;
  sha256: string;
  fetched_at: string;
}

export interface SourceSnapshotRow extends SourceSnapshotMeta {
  text_content: string;
}

export async function getSourceSnapshot(db: Db, snapshotId: string): Promise<SourceSnapshotRow | null> {
  const rows = unwrap(
    await db.from('source_snapshots').select('*').eq('id', snapshotId).limit(1),
  ) as SourceSnapshotRow[];
  return rows[0] ?? null;
}

/** Snapshot metadata (without the page text) for one job (all of it, paged). */
export async function listSnapshotMeta(db: Db, jobId: string): Promise<SourceSnapshotMeta[]> {
  return selectAllPages<SourceSnapshotMeta>((from, to) =>
    db
      .from('source_snapshots')
      .select('id, job_id, url, final_url, http_status, content_type, title, sha256, fetched_at')
      .eq('job_id', jobId)
      .order('fetched_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  );
}

// ---------------------------------------------------------------------------
// Review decisions (append-only audit log)
// ---------------------------------------------------------------------------

export interface ReviewDecisionRow {
  id: number;
  case_id: string;
  version: number;
  action: string;
  actor: string;
  at: string;
  notes: string | null;
  scheduled_for: string | null;
  doc_sha256: string | null;
}

export async function listReviewDecisions(db: Db, caseId: string, version?: number): Promise<ReviewDecisionRow[]> {
  let q = db.from('review_decisions').select('*').eq('case_id', caseId);
  if (version !== undefined) q = q.eq('version', version);
  return unwrap(await q.order('at', { ascending: false }).order('id', { ascending: false })) as ReviewDecisionRow[];
}

// ---------------------------------------------------------------------------
// User signals (admin RPCs)
// ---------------------------------------------------------------------------

export interface FairnessSideSignal {
  side_id: string;
  ratings: number;
  fair: number;
  somewhat_fair: number;
  unfair: number;
  unfair_share: number | null;
}

export interface StepFlagSignal {
  step_id: string;
  open: number;
  total: number;
  by_reason: Record<string, number> | null;
  notes: string[] | null;
}

export interface FairnessSignals {
  sides: FairnessSideSignal[];
  flags: StepFlagSignal[];
  alerts: ReviewAlertRow[];
}

/** Fairness ratings per side, user fact flags per step, and alerts, for one version. */
export async function adminFairnessSignals(db: Db, caseId: string, version: number): Promise<FairnessSignals> {
  const raw = unwrap(
    await db.rpc('admin_fairness_signals', { p_case_id: caseId, p_version: version }),
  ) as Partial<FairnessSignals> | null;
  return { sides: raw?.sides ?? [], flags: raw?.flags ?? [], alerts: raw?.alerts ?? [] };
}

/**
 * Marks readers' open fact flags on one step of one version as reviewed. Row-level
 * security allows this only for the admin, and only resolved_at / resolved_by are
 * writable. Returns how many flags were marked.
 */
export async function adminResolveFactFlags(db: Db, caseId: string, version: number, stepId: string, actor: string): Promise<number> {
  const rows = unwrap(
    await db
      .from('fact_flags')
      .update({ resolved_at: new Date().toISOString(), resolved_by: actor })
      .eq('case_id', caseId)
      .eq('case_version', version)
      .eq('step_id', stepId)
      .is('resolved_at', null)
      .select('id'),
  ) as { id: number }[];
  return rows.length;
}

export interface FlagsBySideRow {
  step_id: string;
  /** The flagger's own side from the fairness question, or "unrated". */
  side_id: string;
  flags: number;
}

export async function adminFlagsBySide(db: Db, caseId: string, version: number): Promise<FlagsBySideRow[]> {
  return (unwrap(await db.rpc('admin_flags_by_side', { p_case_id: caseId, p_version: version })) ??
    []) as FlagsBySideRow[];
}

// ---------------------------------------------------------------------------
// Crowd readouts (admin RPCs)
// ---------------------------------------------------------------------------

export interface AdminFinalCrowdStep {
  step_id: string;
  /** Shares (0..1) of finished readers who agreed, were not sure, or disagreed; null when nobody counts. */
  votes: { agree: number; unsure: number; disagree: number } | null;
}

export interface AdminVersionNote {
  version: number;
  published_at: string | null;
  parent_version: number | null;
  earlier_versions: { version: number; published_at: string | null; completions: number }[];
}

/** app.final_crowd plus real completions and the version note, as admin_final_crowd returns it. */
export interface AdminFinalCrowd {
  n_real: number;
  n_seed: number;
  /** How much each seeded row counts now (1 = full, 0 = faded or left out). */
  seed_weight: number;
  /** Share of the total weight that comes from seeded rows (0..1). */
  seeded_share: number;
  /** Ten 10-point bins (shares), or null when nobody counts. */
  before_histogram: number[] | null;
  after_histogram: number[] | null;
  mean_before: number | null;
  mean_after: number | null;
  steps: AdminFinalCrowdStep[];
  /** The fact where agree and disagree were closest to even. */
  most_split_step_id: string | null;
  real_completions: number;
  version_note: AdminVersionNote | null;
}

export async function adminFinalCrowd(db: Db, caseId: string, version: number, includeSeed = true): Promise<AdminFinalCrowd> {
  const raw = unwrap(
    await db.rpc('admin_final_crowd', { p_case_id: caseId, p_version: version, p_include_seed: includeSeed }),
  ) as Partial<AdminFinalCrowd> | null;
  return {
    n_real: Number(raw?.n_real ?? 0),
    n_seed: Number(raw?.n_seed ?? 0),
    seed_weight: Number(raw?.seed_weight ?? 0),
    seeded_share: Number(raw?.seeded_share ?? 0),
    before_histogram: raw?.before_histogram ?? null,
    after_histogram: raw?.after_histogram ?? null,
    mean_before: raw?.mean_before ?? null,
    mean_after: raw?.mean_after ?? null,
    steps: raw?.steps ?? [],
    most_split_step_id: raw?.most_split_step_id ?? null,
    real_completions: Number(raw?.real_completions ?? 0),
    version_note: raw?.version_note ?? null,
  };
}

// ---------------------------------------------------------------------------
// Admin edit drafts and job control
// ---------------------------------------------------------------------------

/** The admin's open edit draft derived from `baseVersion`, if there is one (the draft admin_save_edit would continue). */
export async function findAdminEditDraft(db: Db, caseId: string, baseVersion: number): Promise<number | null> {
  const rows = unwrap(
    await db
      .from('staff_case_versions')
      .select('version')
      .eq('case_id', caseId)
      .eq('based_on_version', baseVersion)
      .eq('status', 'draft')
      .eq('origin', 'admin')
      .contains('tags', ['admin_edit'])
      .order('version', { ascending: false })
      .limit(1),
  ) as { version: number }[];
  return rows[0]?.version ?? null;
}

/** Cancels a job that no worker has claimed yet. Row-level security allows only the admin, and only queued -> cancelled. */
export async function adminCancelJob(db: Db, jobId: string): Promise<void> {
  const rows = unwrap(
    await db.from('pipeline_jobs').update({ status: 'cancelled' }).eq('id', jobId).eq('status', 'queued').select('id'),
  ) as { id: string }[];
  if (rows.length === 0) throw new StoreError(`job ${jobId} is not queued (or not visible)`, 'PT409');
}
