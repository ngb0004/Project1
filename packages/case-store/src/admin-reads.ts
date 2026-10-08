import type { SeedProfile } from '@sia/case-schema';
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
  status: string;
  title: string;
  as_of: string;
  published_at: string | null;
  is_live: boolean | null;
}

export async function listVersionSummaries(db: Db, caseIds: string[]): Promise<VersionSummaryRow[]> {
  if (caseIds.length === 0) return [];
  return unwrap(
    await db
      .from('staff_case_versions')
      .select('case_id, slug, version, status, title, as_of, published_at, is_live')
      .in('case_id', caseIds)
      .order('version', { ascending: false }),
  ) as VersionSummaryRow[];
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

/** Every query run, page opened and claim extracted by one pipeline job, in order. */
export async function listResearchLog(db: Db, jobId: string, limit = 5000): Promise<ResearchLogRow[]> {
  return unwrap(
    await db.from('research_log').select('*').eq('job_id', jobId).order('id', { ascending: true }).limit(limit),
  ) as ResearchLogRow[];
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

/** Snapshot metadata (without the page text) for one job. */
export async function listSnapshotMeta(db: Db, jobId: string): Promise<SourceSnapshotMeta[]> {
  return unwrap(
    await db
      .from('source_snapshots')
      .select('id, job_id, url, final_url, http_status, content_type, title, sha256, fetched_at')
      .eq('job_id', jobId)
      .order('fetched_at', { ascending: true }),
  ) as SourceSnapshotMeta[];
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
