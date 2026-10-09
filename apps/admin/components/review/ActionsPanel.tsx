'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { Case } from '@sia/case-schema';
import {
  archiveVersion,
  editThenApprove,
  publishVersion,
  rejectVersion,
  requestChanges,
  saveEdits,
  scheduleVersion,
  unscheduleVersion,
} from '@/app/(console)/review/actions';
import { LocalTime, localWithZone, zoneName } from '@/components/LocalTime';
import type { ActionResult } from '@/lib/form-state';
import { combineNotes } from '@/lib/review-triage';
import type { ActionKey, ActionState } from '@/lib/review-actions';

export interface ActionsMeta {
  caseId: string;
  version: number;
  scheduledAt: string | null;
  /** The admin's open edit draft of this version, if any. */
  existingDraft: number | null;
  isAdminDraft: boolean;
}

/** Runs one write at a time for the whole review screen (Save in the savebar, or any action here). */
export type RunWrite = (fn: () => Promise<ActionResult>, after?: (r: ActionResult) => void) => void;

/** `datetime-local` value one hour from now, in the browser's time zone. */
function inAnHour(): string {
  const d = new Date(Date.now() + 3600_000);
  d.setSeconds(0, 0);
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 16);
}

function Reason({ state }: { state: ActionState }) {
  return state.reason ? <p className={state.enabled ? 'small muted' : 'reason'}>{state.reason}</p> : null;
}

function Cautions({ list }: { list: string[] }) {
  if (!list.length) return null;
  return (
    <div className="caution small" data-testid="approve-cautions">
      <strong>Still unresolved in the review record:</strong>
      <ul>
        {list.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      Approving is allowed; make sure it is on purpose.
    </div>
  );
}

const cautionText = (list: string[]) => (list.length ? `\n\nStill unresolved:\n${list.map((c) => `• ${c}`).join('\n')}` : '');

const NOTE_MAX = 3000;

/**
 * The five review actions (plus Save, Archive and Unschedule). Destructive
 * ones ask for confirmation; every result or error is shown here. One write
 * runs at a time across the whole screen.
 */
export function ActionsPanel({
  meta,
  actions,
  getWorkingDoc,
  getTriage,
  cautions,
  dirty,
  run,
  busy,
  onNavigate,
  onSettled,
}: {
  meta: ActionsMeta;
  actions: Record<ActionKey, ActionState>;
  getWorkingDoc: () => Case;
  /** Plain-words lines for the admin's triage of review items, added to the decision notes. */
  getTriage: () => string[];
  /** Unresolved review items, shown as a caution on the approve actions. */
  cautions: string[];
  dirty: boolean;
  run: RunWrite;
  busy: boolean;
  /** A save or edit-then-approve succeeded: go to the version it wrote. */
  onNavigate: (href: string, notice: 'saved' | 'published') => void;
  /** Any other action succeeded and the page refreshed in place. */
  onSettled: () => void;
}) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [publishNotes, setPublishNotes] = useState('');
  // Filled in after mount: the default depends on the browser's clock and time zone.
  const [scheduleAt, setScheduleAt] = useState('');
  const [zone, setZone] = useState('');
  useEffect(() => {
    setScheduleAt((v) => v || inAnHour());
    setZone(zoneName());
  }, []);
  const [scheduleNotes, setScheduleNotes] = useState('');
  const [changeNotes, setChangeNotes] = useState('');
  const [editApproveNotes, setEditApproveNotes] = useState('');
  const [saveNotes, setSaveNotes] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [archiveNotes, setArchiveNotes] = useState('');
  const { caseId, version } = meta;

  const go = (confirmText: string | null, fn: () => Promise<ActionResult>, after?: (r: ActionResult) => void) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setResult(null);
    run(fn, (r) => {
      setResult(r);
      after?.(r);
    });
  };

  const navigateOnSuccess = (notice: 'saved' | 'published') => (r: ActionResult) => {
    if (r.ok && r.href) onNavigate(r.href, notice);
  };
  const settled = (r: ActionResult) => {
    if (r.ok) onSettled();
  };

  const resultBox = result ? (
    <div className={`notice ${result.ok ? 'notice-ok' : 'notice-error'}`} role={result.ok ? 'status' : 'alert'} data-testid="action-result">
      {result.ok ? result.message : result.error}
      {result.ok && result.at ? (
        <>
          {' '}
          (<LocalTime iso={result.at} />)
        </>
      ) : null}
      {!result.ok && result.href ? (
        <>
          {' '}
          <Link href={result.href}>Open draft v{result.version}</Link>
        </>
      ) : null}
    </div>
  ) : null;

  const shown = (Object.keys(actions) as ActionKey[]).filter((k) => actions[k].shown);
  if (shown.length === 0) {
    return (
      <div data-testid="actions-panel">
        {resultBox}
        <p className="empty">This version is final (no actions apply). Open the live version or the queue to keep working.</p>
      </div>
    );
  }
  const draftNote =
    meta.existingDraft && !meta.isAdminDraft ? (
      <p className="notice notice-warn small">
        You already have an edit draft of this version: <Link href={`/review/${caseId}/${meta.existingDraft}`}>v{meta.existingDraft}</Link>. Saving
        here replaces that draft&rsquo;s content with this working copy.
      </p>
    ) : null;
  const dirtyWarning = dirty ? '\n\nYour unsaved inline edits are not part of this: they are discarded when the version leaves review.' : '';

  return (
    <div data-testid="actions-panel">
      {resultBox}
      {draftNote}
      <div className="action-grid">
        {actions.publish.shown ? (
          <div className={`action ${actions.publish.enabled ? '' : 'action-disabled'}`}>
            <h3>Approve and publish</h3>
            <p className="small muted">Creates the immutable published version and makes it live now.</p>
            {actions.publish.enabled ? <Cautions list={cautions} /> : null}
            <label className="field">
              <span className="field-label">Notes · optional</span>
              <textarea value={publishNotes} onChange={(e) => setPublishNotes(e.target.value)} rows={2} maxLength={NOTE_MAX} />
            </label>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!actions.publish.enabled || busy}
              data-testid="action-publish"
              onClick={() =>
                go(`Publish v${version} now? It becomes the live version users get.${cautionText(cautions)}`, () => publishVersion({ caseId, version, notes: publishNotes }), settled)
              }
            >
              Approve and publish
            </button>
            <Reason state={actions.publish} />
          </div>
        ) : null}

        {actions.schedule.shown ? (
          <div className={`action ${actions.schedule.enabled ? '' : 'action-disabled'}`}>
            <h3>Approve and schedule</h3>
            <p className="small muted">Same approval, but it goes live at the time you set.</p>
            {actions.schedule.enabled ? <Cautions list={cautions} /> : null}
            <div className="fields-2">
              <label className="field">
                <span className="field-label">Go live at{zone ? ` · your time (${zone})` : ''}</span>
                <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} data-testid="schedule-at" />
                {scheduleAt && !Number.isNaN(new Date(scheduleAt).getTime()) ? (
                  <span className="field-hint" data-testid="schedule-utc">
                    = {new Date(scheduleAt).toISOString().slice(0, 16).replace('T', ' ')} UTC
                  </span>
                ) : null}
              </label>
              <label className="field">
                <span className="field-label">Notes · optional</span>
                <input type="text" value={scheduleNotes} onChange={(e) => setScheduleNotes(e.target.value)} maxLength={NOTE_MAX} />
              </label>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!actions.schedule.enabled || busy || !scheduleAt}
              data-testid="action-schedule"
              onClick={() => {
                const at = new Date(scheduleAt);
                if (Number.isNaN(at.getTime())) return setResult({ ok: false, error: 'Pick a date and time.' });
                go(
                  `Schedule v${version} to go live at ${localWithZone(at.toISOString())} (${at.toISOString().slice(0, 16).replace('T', ' ')} UTC)?${cautionText(cautions)}`,
                  () => scheduleVersion({ caseId, version, at: at.toISOString(), notes: scheduleNotes }),
                  settled,
                );
              }}
            >
              Approve and schedule
            </button>
            <Reason state={actions.schedule} />
          </div>
        ) : null}

        {actions.unschedule.shown ? (
          <div className="action">
            <h3>Scheduled</h3>
            <p className="small muted">
              Goes live at <LocalTime iso={meta.scheduledAt} /> unless you cancel the schedule.
            </p>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => go('Cancel the scheduled publish?', () => unscheduleVersion({ caseId, version }), settled)}>
              Unschedule
            </button>
          </div>
        ) : null}

        {actions.edit_then_approve.shown ? (
          <div className={`action ${actions.edit_then_approve.enabled ? '' : 'action-disabled'}`}>
            <h3>Edit then approve</h3>
            <p className="small muted">Saves your inline edits as a new draft version tagged admin_edit, then publishes that draft.</p>
            {actions.edit_then_approve.enabled ? <Cautions list={cautions} /> : null}
            <label className="field">
              <span className="field-label">What you changed · optional</span>
              <textarea value={editApproveNotes} onChange={(e) => setEditApproveNotes(e.target.value)} rows={2} maxLength={NOTE_MAX} data-testid="edit-notes" />
            </label>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!actions.edit_then_approve.enabled || busy}
              data-testid="action-edit-approve"
              onClick={() =>
                go(
                  (meta.existingDraft && !meta.isAdminDraft
                    ? `This replaces the content of your edit draft v${meta.existingDraft} with this working copy and publishes it now. Continue?`
                    : 'Save your edits as a new version and publish it now?') + cautionText(cautions),
                  () => editThenApprove({ caseId, version, doc: getWorkingDoc(), notes: combineNotes(editApproveNotes, getTriage()) }),
                  navigateOnSuccess('published'),
                )
              }
            >
              Save edits and publish
            </button>
            <Reason state={actions.edit_then_approve} />
          </div>
        ) : null}

        {actions.save_edit.shown ? (
          <div className={`action ${actions.save_edit.enabled ? '' : 'action-disabled'}`}>
            <h3>Save edits</h3>
            <p className="small muted">{meta.isAdminDraft ? 'Updates this draft with your edits.' : 'Saves your edits as a draft version tagged admin_edit, for review before publishing.'}</p>
            <label className="field">
              <span className="field-label">What you changed · optional</span>
              <textarea value={saveNotes} onChange={(e) => setSaveNotes(e.target.value)} rows={2} maxLength={NOTE_MAX} data-testid="save-notes" />
            </label>
            <button
              type="button"
              className="btn"
              disabled={!actions.save_edit.enabled || busy}
              data-testid="action-save"
              onClick={() =>
                go(
                  meta.existingDraft && !meta.isAdminDraft ? `Replace the content of draft v${meta.existingDraft} with this working copy?` : null,
                  () => saveEdits({ caseId, version, doc: getWorkingDoc(), notes: combineNotes(saveNotes, getTriage()) }),
                  navigateOnSuccess('saved'),
                )
              }
            >
              Save edits
            </button>
            <Reason state={actions.save_edit} />
          </div>
        ) : null}

        {actions.request_changes.shown ? (
          <div className="action">
            <h3>Request changes</h3>
            <p className="small muted">Sends your notes back to the pipeline, which runs a revision round using them as instructions.</p>
            {dirty ? <p className="reason">Your unsaved inline edits are not sent: only these notes are. Put what matters in them.</p> : null}
            <label className="field">
              <span className="field-label">Notes for the pipeline · required</span>
              <textarea value={changeNotes} onChange={(e) => setChangeNotes(e.target.value)} rows={3} maxLength={NOTE_MAX} data-testid="change-notes" />
            </label>
            <button
              type="button"
              className="btn"
              disabled={busy || !changeNotes.trim()}
              data-testid="action-request-changes"
              onClick={() => go(`Send v${version} back to the pipeline with these notes?${dirtyWarning}`, () => requestChanges({ caseId, version, notes: changeNotes }), settled)}
            >
              Request changes
            </button>
          </div>
        ) : null}

        {actions.reject.shown ? (
          <div className="action">
            <h3>{meta.isAdminDraft ? 'Discard draft' : 'Reject'}</h3>
            <p className="small muted">Archives the package and stores the reason. This cannot be undone.</p>
            {dirty ? <p className="reason">You have unsaved inline edits: they are discarded too.</p> : null}
            <label className="field">
              <span className="field-label">Reason · required</span>
              <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} rows={2} maxLength={NOTE_MAX} data-testid="reject-reason" />
            </label>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy || !rejectReason.trim()}
              data-testid="action-reject"
              onClick={() => go(`Reject v${version}? This is final.${dirtyWarning}`, () => rejectVersion({ caseId, version, reason: rejectReason }), settled)}
            >
              {meta.isAdminDraft ? 'Discard draft' : 'Reject'}
            </button>
          </div>
        ) : null}

        {actions.archive.shown ? (
          <div className="action">
            <h3>Archive</h3>
            <p className="small muted">Retires this version. Its document and its responses stay as they are.</p>
            <label className="field">
              <span className="field-label">Notes · optional</span>
              <input type="text" value={archiveNotes} onChange={(e) => setArchiveNotes(e.target.value)} maxLength={NOTE_MAX} />
            </label>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              data-testid="action-archive"
              onClick={() =>
                go(actions.archive.reason ? `Archive v${version}? ${actions.archive.reason}` : `Archive v${version}?`, () => archiveVersion({ caseId, version, notes: archiveNotes }), settled)
              }
            >
              Archive
            </button>
            <Reason state={actions.archive} />
          </div>
        ) : null}
      </div>
      {busy ? (
        <p className="small muted" role="status">
          Working…
        </p>
      ) : null}
    </div>
  );
}
