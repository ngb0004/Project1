'use server';

import { refresh } from 'next/cache';
import type { Case } from '@sia/case-schema';
import {
  adminArchive,
  adminPublish,
  adminReject,
  adminRequestChanges,
  adminResolveFactFlags,
  adminSaveEdit,
  adminSchedule,
  adminUnschedule,
  listResearchLogPage,
  type Db,
  type ResearchLogRow,
} from '@sia/case-store';
import { adminForAction } from '@/lib/auth';
import { describeError } from '@/lib/errors';
import { isUuid } from '@/lib/format';
import type { ActionResult } from '@/lib/form-state';

/**
 * Review actions. Each one runs as the signed-in admin through the database's
 * review RPCs (row-level security and the version guard check every one), and
 * each is logged as a decision. A missing or non-admin session comes back as a
 * typed error, never a redirect: the review screen keeps the admin's unsaved
 * working copy and can retry after they sign in again in another tab.
 */

/** Decision notes are stored in the review record, which allows 8,000 characters. */
const NOTES_MAX = 7500;

async function begin(t: Target): Promise<{ db: Db; email: string } | ActionResult> {
  const auth = await adminForAction();
  if (!auth.ok) return { ok: false, error: auth.error };
  const bad = badTarget(t);
  if (bad) return bad;
  return { db: auth.session.db, email: auth.session.email };
}

const failed = (x: { db: Db; email: string } | ActionResult): x is ActionResult => 'ok' in x;

function tooLong(...notes: (string | undefined)[]): ActionResult | null {
  for (const n of notes) {
    if (n && n.length > NOTES_MAX) return { ok: false, error: `Notes are limited to ${NOTES_MAX.toLocaleString('en-US')} characters (yours has ${n.length.toLocaleString('en-US')}).` };
  }
  return null;
}

interface Target {
  caseId: string;
  version: number;
}

function badTarget(t: Target): ActionResult | null {
  if (!isUuid(t.caseId) || !Number.isInteger(t.version) || t.version < 1) return { ok: false, error: 'Unknown case version.' };
  return null;
}

const reviewHref = (caseId: string, version: number) => `/review/${caseId}/${version}`;
const note = (s: string | undefined) => (s && s.trim() ? s.trim() : undefined);

export async function publishVersion(t: Target & { notes?: string }): Promise<ActionResult> {
  const s = await begin(t);
  if (failed(s)) return s;
  const { db } = s;
  const long = tooLong(t.notes);
  if (long) return long;
  try {
    const r = await adminPublish(db, t.caseId, t.version, note(t.notes));
    refresh();
    return { ok: true, message: `Published v${t.version}. It is live now (live version v${r.live_version}).`, version: t.version };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}

export async function scheduleVersion(t: Target & { at: string; notes?: string }): Promise<ActionResult> {
  const s = await begin(t);
  if (failed(s)) return s;
  const { db } = s;
  const long = tooLong(t.notes);
  if (long) return long;
  const at = new Date(t.at);
  if (Number.isNaN(at.getTime())) return { ok: false, error: 'Pick a date and time to publish.' };
  if (at.getTime() <= Date.now()) return { ok: false, error: 'The publish time must be in the future.' };
  try {
    await adminSchedule(db, t.caseId, t.version, at, note(t.notes));
    refresh();
    return { ok: true, message: `Approved. v${t.version} goes live at ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC.`, at: at.toISOString() };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}

export async function unscheduleVersion(t: Target): Promise<ActionResult> {
  const s = await begin(t);
  if (failed(s)) return s;
  const { db } = s;
  try {
    await adminUnschedule(db, t.caseId, t.version);
    refresh();
    return { ok: true, message: `Schedule cancelled. v${t.version} is back in review.` };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}

export async function requestChanges(t: Target & { notes: string }): Promise<ActionResult> {
  const s = await begin(t);
  if (failed(s)) return s;
  const { db } = s;
  if (!t.notes?.trim()) return { ok: false, error: 'Write notes for the pipeline: they are its instructions for the revision round.' };
  const long = tooLong(t.notes);
  if (long) return long;
  try {
    const r = await adminRequestChanges(db, t.caseId, t.version, t.notes.trim());
    refresh();
    return { ok: true, message: `Changes requested. Revision job ${r.job_id.slice(0, 8)} is queued with your notes.` };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}

export async function rejectVersion(t: Target & { reason: string }): Promise<ActionResult> {
  const s = await begin(t);
  if (failed(s)) return s;
  const { db } = s;
  if (!t.reason?.trim()) return { ok: false, error: 'A reason is required to reject.' };
  const long = tooLong(t.reason);
  if (long) return long;
  try {
    await adminReject(db, t.caseId, t.version, t.reason.trim());
    refresh();
    return { ok: true, message: `Rejected v${t.version}. The reason is stored in the review record.` };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}

export async function archiveVersion(t: Target & { notes?: string }): Promise<ActionResult> {
  const s = await begin(t);
  if (failed(s)) return s;
  const { db } = s;
  try {
    await adminArchive(db, t.caseId, t.version, note(t.notes));
    refresh();
    return { ok: true, message: `Archived v${t.version}.` };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}

/**
 * Saves the working copy as the admin_edit draft based on `version` (or
 * updates that draft when `version` is the draft itself). Validated with the
 * shared schema first; the database validates again on publish.
 */
export async function saveEdits(t: Target & { doc: Case; notes?: string }): Promise<ActionResult> {
  const s = await begin(t);
  if (failed(s)) return s;
  const { db } = s;
  const long = tooLong(t.notes);
  if (long) return long;
  try {
    const r = await adminSaveEdit(db, t.caseId, t.version, t.doc, note(t.notes));
    refresh();
    return {
      ok: true,
      message: r.version === t.version ? `Saved your edits to draft v${r.version}.` : `Saved your edits as draft v${r.version} (admin_edit).`,
      version: r.version,
      href: reviewHref(t.caseId, r.version),
    };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}

/** Edit then approve: saves the admin_edit draft, then publishes that draft. */
export async function editThenApprove(t: Target & { doc: Case; notes?: string }): Promise<ActionResult> {
  const s = await begin(t);
  if (failed(s)) return s;
  const { db } = s;
  const long = tooLong(t.notes);
  if (long) return long;
  let draft: number;
  try {
    draft = (await adminSaveEdit(db, t.caseId, t.version, t.doc, note(t.notes))).version;
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
  try {
    const r = await adminPublish(db, t.caseId, draft, note(t.notes) ?? `Edited and approved from v${t.version}.`);
    refresh();
    return {
      ok: true,
      message: `Saved your edits as v${draft} and published it. v${r.live_version} is live.`,
      version: draft,
      href: reviewHref(t.caseId, draft),
    };
  } catch (e) {
    refresh();
    return {
      ok: false,
      error: `Your edits were saved as draft v${draft}, but publishing failed: ${describeError(e)}`,
      version: draft,
      href: reviewHref(t.caseId, draft),
    };
  }
}

/** Marks readers' open fact flags on one step as reviewed (they stop counting toward the flag alert). */
export async function resolveReaderFlags(t: Target & { stepId: string }): Promise<ActionResult> {
  const s = await begin(t);
  if (failed(s)) return s;
  if (typeof t.stepId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(t.stepId)) return { ok: false, error: 'Unknown step.' };
  try {
    const n = await adminResolveFactFlags(s.db, t.caseId, t.version, t.stepId, s.email);
    refresh();
    return { ok: true, message: n ? `Marked ${n} reader flag${n === 1 ? '' : 's'} on this step as reviewed.` : 'No open reader flags were left on this step.' };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}

export type ResearchLogPage = { ok: true; rows: ResearchLogRow[]; more: boolean } | { ok: false; error: string };

/**
 * One page of one agent's research log (agent, scope and round), loaded when
 * the admin opens that group in the Research log tab, so the review page does
 * not ship the whole log. Row-level security limits the log to staff.
 */
export async function loadResearchLog(t: Target & { jobId: string; agent: string; scope: string | null; round: number; offset: number }): Promise<ResearchLogPage> {
  const s = await begin(t);
  if (failed(s)) return { ok: false, error: s.ok ? 'Unexpected result.' : s.error };
  if (!isUuid(t.jobId) || typeof t.agent !== 'string' || t.agent.length > 64 || !Number.isInteger(t.round) || t.round < 0) {
    return { ok: false, error: 'Unknown research log group.' };
  }
  if (t.scope !== null && (typeof t.scope !== 'string' || t.scope.length > 64)) return { ok: false, error: 'Unknown research log group.' };
  const offset = Number.isInteger(t.offset) && t.offset >= 0 ? t.offset : 0;
  try {
    const PAGE = 200;
    const rows = await listResearchLogPage(s.db, t.jobId, { agent: t.agent, scope: t.scope, round: t.round }, offset, PAGE + 1);
    return { ok: true, rows: rows.slice(0, PAGE), more: rows.length > PAGE };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}
