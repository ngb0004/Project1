import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  assertValidCase,
  type Case,
  type CaseInput,
  type CaseStatus,
  type PublicCase,
  type SeedProfileInput,
} from '@sia/case-schema';

/**
 * Typed data access over the Supabase API. Every write goes through a database
 * function that runs as the signed-in user, so row-level security decides what
 * is allowed; this module never holds a service-role key.
 */

export type Db = SupabaseClient;

export type StaffRole = 'admin' | 'pipeline';

export interface StaffCredentials {
  email: string;
  password: string;
}

export class StoreError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}

function unwrap<T>(res: { data: T | null; error: { message: string; code?: string; details?: unknown } | null }): T {
  if (res.error) throw new StoreError(res.error.message, res.error.code, res.error.details);
  return res.data as T;
}

/** An anonymous client (the dive app's view of the world). */
export function createAnonClient(url: string, anonKey: string, headers?: Record<string, string>): Db {
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: headers ? { headers } : undefined,
  });
}

/** Signs in a staff account (the owner or the pipeline worker) and returns its client. */
export async function signInStaff(url: string, anonKey: string, creds: StaffCredentials): Promise<Db> {
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: true } });
  const { error } = await client.auth.signInWithPassword(creds);
  if (error) throw new StoreError(`staff sign-in failed: ${error.message}`, error.code);
  return client;
}

// ---------------------------------------------------------------------------
// Package import (the single path for pipeline output and seed cases)
// ---------------------------------------------------------------------------

export interface SubmitPackageInput {
  slug: string;
  doc: Case | CaseInput;
  jobId?: string | null;
  basedOnVersion?: number | null;
  tags?: string[];
  origin?: 'pipeline' | 'import';
}

export interface VersionRef {
  case_id: string;
  version: number;
  slug?: string;
}

/**
 * Validates a case document with the shared schema and submits it for review.
 * The database always stores it as `in_review`; publishing is an admin action.
 */
export async function submitCasePackage(db: Db, input: SubmitPackageInput): Promise<VersionRef> {
  // The database assigns id, version and status; validate the rest now.
  const given = input.doc as Partial<Case>;
  const doc = assertValidCase({
    ...input.doc,
    id: given.id ?? 'pending',
    slug: input.slug,
    status: 'in_review',
    version: Math.max(given.version ?? 1, (given.parent_version ?? 0) + 1),
  });
  return unwrap(
    await db.rpc('submit_case_package', {
      p_slug: input.slug,
      p_doc: doc,
      p_job_id: input.jobId ?? null,
      p_based_on_version: input.basedOnVersion ?? null,
      p_tags: input.tags ?? [],
      p_origin: input.origin ?? 'pipeline',
    }),
  );
}

// ---------------------------------------------------------------------------
// Staff reads
// ---------------------------------------------------------------------------

export interface StaffVersionRow {
  case_id: string;
  slug: string;
  version: number;
  status: CaseStatus;
  origin: 'pipeline' | 'admin' | 'import';
  parent_version: number | null;
  based_on_version: number | null;
  tags: string[];
  doc: Case;
  title: string;
  as_of: string;
  pipeline_job_id: string | null;
  created_at: string;
  created_by: string;
  submitted_at: string | null;
  published_at: string | null;
  published_by: string | null;
  scheduled_publish_at: string | null;
  is_live: boolean | null;
  live_version: number | null;
}

export async function getStaffVersion(db: Db, caseId: string, version: number): Promise<StaffVersionRow | null> {
  const rows = unwrap(
    await db.from('staff_case_versions').select('*').eq('case_id', caseId).eq('version', version).limit(1),
  ) as StaffVersionRow[];
  return rows[0] ?? null;
}

export async function listStaffVersions(db: Db, caseId: string): Promise<StaffVersionRow[]> {
  return unwrap(
    await db.from('staff_case_versions').select('*').eq('case_id', caseId).order('version', { ascending: false }),
  ) as StaffVersionRow[];
}

export interface QueueRow {
  case_id: string;
  slug: string;
  version: number;
  status: CaseStatus;
  origin: string;
  tags: string[];
  title: string;
  as_of: string;
  parent_version: number | null;
  based_on_version: number | null;
  live_version: number | null;
  is_live: boolean | null;
  created_at: string;
  submitted_at: string | null;
  scheduled_publish_at: string | null;
  pipeline_job_id: string | null;
  open_issue_count: number;
  step_count: number;
}

export async function listQueue(db: Db): Promise<QueueRow[]> {
  return unwrap(await db.from('staff_queue').select('*').order('submitted_at', { ascending: true })) as QueueRow[];
}

// ---------------------------------------------------------------------------
// Admin actions
// ---------------------------------------------------------------------------

export async function adminPublish(db: Db, caseId: string, version: number, notes?: string) {
  return unwrap(await db.rpc('admin_publish', { p_case_id: caseId, p_version: version, p_notes: notes ?? null })) as {
    case_id: string;
    version: number;
    live_version: number;
  };
}

export async function adminSchedule(db: Db, caseId: string, version: number, at: Date, notes?: string) {
  return unwrap(
    await db.rpc('admin_schedule', {
      p_case_id: caseId,
      p_version: version,
      p_at: at.toISOString(),
      p_notes: notes ?? null,
    }),
  );
}

export async function adminUnschedule(db: Db, caseId: string, version: number) {
  unwrap(await db.rpc('admin_unschedule', { p_case_id: caseId, p_version: version }));
}

export async function adminRequestChanges(db: Db, caseId: string, version: number, notes: string) {
  return unwrap(
    await db.rpc('admin_request_changes', { p_case_id: caseId, p_version: version, p_notes: notes }),
  ) as { case_id: string; version: number; job_id: string };
}

export async function adminReject(db: Db, caseId: string, version: number, reason: string) {
  unwrap(await db.rpc('admin_reject', { p_case_id: caseId, p_version: version, p_reason: reason }));
}

export async function adminArchive(db: Db, caseId: string, version: number, notes?: string) {
  unwrap(await db.rpc('admin_archive', { p_case_id: caseId, p_version: version, p_notes: notes ?? null }));
}

/**
 * Saves admin edits as a draft version tagged `admin_edit`. The document is
 * validated with the shared schema first; publishing is blocked on any error.
 */
export async function adminSaveEdit(db: Db, caseId: string, baseVersion: number, doc: Case | CaseInput, notes?: string) {
  const valid = assertValidCase(doc);
  return unwrap(
    await db.rpc('admin_save_edit', {
      p_case_id: caseId,
      p_base_version: baseVersion,
      p_doc: valid,
      p_notes: notes ?? null,
    }),
  ) as { case_id: string; version: number; based_on_version: number; parent_version: number | null };
}

export async function adminCreateCase(db: Db, brief: string): Promise<string> {
  return unwrap(await db.rpc('admin_create_case', { p_brief: brief })) as string;
}

export async function adminSetUpdateCadence(db: Db, caseId: string, cadence: string | null) {
  unwrap(await db.rpc('admin_set_update_cadence', { p_case_id: caseId, p_cadence: cadence }));
}

export async function adminRequestUpdate(db: Db, caseId: string): Promise<string> {
  return unwrap(await db.rpc('admin_request_update', { p_case_id: caseId })) as string;
}

export async function adminSetSeedProfile(db: Db, caseId: string, profile: SeedProfileInput | null) {
  return unwrap(await db.rpc('admin_set_seed_profile', { p_case_id: caseId, p_profile: profile })) as {
    case_id: string;
    live_version: number | null;
    seeded_sessions: number;
  };
}

// ---------------------------------------------------------------------------
// Public dive API (anonymous)
// ---------------------------------------------------------------------------

export interface LiveCaseRow {
  case_id: string;
  slug: string;
  version: number;
  title: string;
  as_of: string;
  published_at: string;
  content_warning: string | null;
  step_count: number;
}

export async function listLiveCases(db: Db): Promise<LiveCaseRow[]> {
  return unwrap(await db.rpc('list_live_cases')) as LiveCaseRow[];
}

export interface PublishedCaseRow {
  case_id: string;
  slug: string;
  version: number;
  published_at: string;
  doc: PublicCase;
  is_live: boolean;
}

export async function getPublishedCase(db: Db, slug: string, version?: number): Promise<PublishedCaseRow | null> {
  const rows = unwrap(
    await db.rpc('get_published_case', { p_slug: slug, p_version: version ?? null }),
  ) as PublishedCaseRow[];
  return rows[0] ?? null;
}
