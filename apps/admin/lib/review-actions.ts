import type { CaseStatus } from '@sia/case-schema';

/**
 * Which review actions the screen offers for a version, and why any of them
 * is disabled. The database enforces the same rules; this only keeps the
 * console from offering an action that is bound to fail.
 */

export type ActionKey =
  | 'publish'
  | 'schedule'
  | 'unschedule'
  | 'request_changes'
  | 'save_edit'
  | 'edit_then_approve'
  | 'reject'
  | 'archive';

export interface ActionContext {
  status: CaseStatus;
  origin: 'pipeline' | 'admin' | 'import';
  tags: readonly string[];
  version: number;
  scheduledAt: string | null;
  isLive: boolean;
  /** Version the document says it updates (doc.parent_version). */
  parentVersion: number | null;
  liveVersion: number | null;
  /** Validation errors in the working copy. */
  errors: number;
  /** Validation errors in the saved document (what Approve would publish). */
  savedErrors: number;
  /** The working copy differs from the saved document. */
  dirty: boolean;
}

export interface ActionState {
  /** Offered for this version at all. */
  shown: boolean;
  enabled: boolean;
  /** Why it is disabled (or a caution when enabled), in plain words. */
  reason: string | null;
}

const hidden: ActionState = { shown: false, enabled: false, reason: null };
const ok = (reason: string | null = null): ActionState => ({ shown: true, enabled: true, reason });
const blocked = (reason: string): ActionState => ({ shown: true, enabled: false, reason });

const errorsReason = (n: number, what: string) =>
  `${what} has ${n} validation error${n === 1 ? '' : 's'}. Publishing is blocked until ${n === 1 ? 'it is' : 'they are'} fixed.`;

/** Publishing fails in the database when the version updates something other than the live version. */
export function staleReason(parentVersion: number | null, liveVersion: number | null): string | null {
  if (parentVersion === liveVersion) return null;
  if (liveVersion === null) {
    return `This version updates v${parentVersion}, which is no longer live. Publishing would fail.`;
  }
  if (parentVersion === null) {
    return `v${liveVersion} is live, but this version was not drafted as an update of it. Publishing would fail; edit the live version instead.`;
  }
  return `This version updates v${parentVersion}, but v${liveVersion} is live now. Publishing would fail.`;
}

/**
 * Whether the working copy of a version can be edited inline. Pending versions
 * can, and so can the live version: a published version never changes, so its
 * edits are saved as a new draft (tagged admin_edit) that updates it. An older
 * published version cannot be edited, since a draft of it could never publish.
 */
export function isEditable(status: CaseStatus, isLive: boolean): boolean {
  return status === 'in_review' || status === 'changes_requested' || status === 'draft' || (status === 'published' && isLive);
}

export function reviewActions(ctx: ActionContext): Record<ActionKey, ActionState> {
  const isAdminDraft = ctx.status === 'draft' && ctx.origin === 'admin';
  const approvable = ctx.status === 'in_review' || isAdminDraft;
  const stale = staleReason(ctx.parentVersion, ctx.liveVersion);

  const approve = (): ActionState => {
    if (!approvable) return hidden;
    if (ctx.savedErrors > 0) return blocked(errorsReason(ctx.savedErrors, 'The saved version'));
    if (ctx.dirty) return blocked('You have unsaved edits. Save them first, or use "Edit then approve".');
    if (stale) return blocked(stale);
    return ok();
  };

  const schedule = approve();
  const actions: Record<ActionKey, ActionState> = {
    publish: approve(),
    schedule: ctx.scheduledAt && schedule.shown ? blocked('Already scheduled. Unschedule it first to pick a new time.') : schedule,
    unschedule: ctx.scheduledAt && ctx.status !== 'published' ? ok() : hidden,
    request_changes: ctx.status === 'in_review' ? ok() : hidden,
    save_edit: hidden,
    edit_then_approve: hidden,
    reject: ['in_review', 'changes_requested', 'draft'].includes(ctx.status) ? ok() : hidden,
    archive: ctx.status === 'published'
      ? ok(ctx.isLive ? 'This is the live version: archiving takes the case offline until another version is published.' : null)
      : hidden,
  };

  if (['in_review', 'changes_requested', 'draft'].includes(ctx.status)) {
    actions.save_edit = ctx.errors > 0
      ? blocked(`Fix the ${ctx.errors} validation error${ctx.errors === 1 ? '' : 's'} before saving; drafts must be valid.`)
      : !ctx.dirty
        ? blocked('No unsaved edits.')
        : ok(isAdminDraft ? null : 'Saves your edits as a new draft version tagged admin_edit.');
  }
  if (ctx.status === 'published' && ctx.isLive) {
    // Edits to the live version become a new admin_edit draft that updates it; this version stays as it is.
    actions.save_edit = ctx.errors > 0
      ? blocked(`Fix the ${ctx.errors} validation error${ctx.errors === 1 ? '' : 's'} before saving; drafts must be valid.`)
      : !ctx.dirty
        ? blocked('Edit any field above first. This published version never changes: your edits are saved as a new draft tagged admin_edit.')
        : ok('Saves your edits as a new draft version tagged admin_edit. This published version stays as it is.');
    actions.edit_then_approve = ctx.errors > 0
      ? blocked(errorsReason(ctx.errors, 'The working copy'))
      : !ctx.dirty
        ? blocked('Edit any field above first.')
        : ok();
  }
  if (approvable) {
    actions.edit_then_approve = ctx.errors > 0
      ? blocked(errorsReason(ctx.errors, 'The working copy'))
      : stale
        ? blocked(stale)
        : ctx.dirty
          ? ok()
          : blocked('No edits yet. To publish the version as it is, use “Approve and publish” (no admin_edit version is made).');
  }
  return actions;
}
