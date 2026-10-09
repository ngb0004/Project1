'use client';

import { memo, useState, useTransition } from 'react';
import type { HardQuestion, OpenIssue, Side } from '@sia/case-schema';
import { resolveReaderFlags } from '@/app/(console)/review/actions';
import { ResolveAlertForm } from '@/components/Alerts';
import { formatDateTime } from '@/lib/format';
import type { ActionResult } from '@/lib/form-state';
import {
  ackNote,
  acknowledgeFactCheck,
  RESOLVED_NOTE_PREFIX,
  setBiasFlagStatus,
  setHardQuestionStatus,
  setOpenIssueResolved,
  unacknowledgeFactCheck,
} from '@/lib/review-triage';
import { isFailingVerdict, type CaseLevelFlags, type FactCheckFlag, type Indexed, type RedTeamFlag, type StepFlags } from '@/lib/step-flags';
import { CASE_FLAGS_ID } from '@/lib/issues';
import { useEditor, useReview, useSources } from './editor-context';

const VERDICT_CLASS: Record<string, string> = {
  supported: 'badge-ok',
  partially_supported: 'badge-warn',
  unsupported: 'badge-error',
  source_unavailable: 'badge-error',
  uncited: 'badge-error',
};

const SEVERITY_CLASS: Record<string, string> = { high: 'badge-error', medium: 'badge-warn', low: '' };

export const label = (s: string) => s.replace(/_/g, ' ');

/**
 * Inline triage: a choice of outcomes, each asking for a short note, applied
 * to the working copy (saved with the next "Save edits" as an admin_edit
 * draft, and summarized in the decision log).
 */
function Triage({
  options,
  onApply,
  testId,
}: {
  options: { key: string; label: string; placeholder: string }[];
  onApply: (key: string, note: string) => void;
  testId?: string;
}) {
  const { canEdit, busy } = useReview();
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  if (!canEdit) return null;
  const choice = options.find((o) => o.key === open);
  if (!choice) {
    return (
      <span className="triage" data-testid={testId}>
        {options.map((o) => (
          <button key={o.key} type="button" className="btn btn-small" disabled={busy} onClick={() => setOpen(o.key)}>
            {o.label}…
          </button>
        ))}
      </span>
    );
  }
  return (
    <form
      className="triage-form"
      data-testid={testId ? `${testId}-form` : undefined}
      onSubmit={(e) => {
        e.preventDefault();
        if (!note.trim()) return;
        onApply(choice.key, note.trim());
        setOpen(null);
        setNote('');
      }}
    >
      <label className="field">
        <span className="field-label">{choice.label}: note for the review record · required</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1500} placeholder={choice.placeholder} autoFocus />
      </label>
      <span className="row">
        <button type="submit" className="btn btn-small btn-primary" disabled={!note.trim() || busy}>
          {choice.label}
        </button>
        <button type="button" className="btn btn-small" onClick={() => setOpen(null)}>
          Cancel
        </button>
        <span className="small faint">Saved with your next “Save edits”.</span>
      </span>
    </form>
  );
}

function Reopen({ onClick, what }: { onClick: () => void; what: string }) {
  const { canEdit, busy } = useReview();
  if (!canEdit) return null;
  return (
    <button type="button" className="btn-link small" disabled={busy} onClick={onClick} aria-label={`Reopen this ${what}`}>
      Reopen
    </button>
  );
}

export function FactCheckItem({ f, stepId }: { f: FactCheckFlag; stepId?: string }) {
  const { update } = useEditor();
  const sources = useSources();
  const r = f.row;
  const sourceTitle = r.source_id ? (sources.find((s) => s.id === r.source_id)?.title ?? r.source_id) : null;
  const needsCall = f.latest && (isFailingVerdict(r.verdict) || r.verdict === 'partially_supported');
  return (
    <li data-testid={`fact-check-${f.index}`}>
      <span className={`badge ${VERDICT_CLASS[r.verdict] ?? ''}`}>{label(r.verdict)}</span>{' '}
      <span className="faint small">
        round {r.round ?? 0}
        {f.latest ? ' (latest)' : ''}
        {f.layerId ? ` · layer ${f.layerId}` : ''}
        {sourceTitle ? ` · ${sourceTitle}` : ''}
      </span>
      <div>{r.claim}</div>
      {r.confidence_before && r.confidence_after && r.confidence_before !== r.confidence_after ? (
        <div className="small">
          Confidence: {r.confidence_before} → <strong>{r.confidence_after}</strong>
        </div>
      ) : null}
      {r.quote ? <div className="quote small">&ldquo;{r.quote}&rdquo;</div> : null}
      {r.note ? <div className="small muted">{r.note}</div> : null}
      {f.ack ? (
        <div className="small triage-done">
          <span className="badge badge-ok">addressed by the admin</span> {ackNote(f.ack)}{' '}
          <Reopen what="fact-check note" onClick={() => update((d) => unacknowledgeFactCheck(d, f.index))} />
        </div>
      ) : needsCall ? (
        <Triage
          testId={`triage-fc-${f.index}`}
          options={[{ key: 'ack', label: 'Mark addressed', placeholder: 'What you changed, or why the claim stands as written.' }]}
          onApply={(_k, note) => update((d) => acknowledgeFactCheck(d, f.index, note, stepId))}
        />
      ) : null}
    </li>
  );
}

export function RedTeamItem({ r, sideLabel, showKind = true }: { r: RedTeamFlag; sideLabel: (id: string | undefined | null) => string; showKind?: boolean }) {
  const { update } = useEditor();
  return (
    <li data-testid={`red-team-${r.flag.id}`}>
      <span className={`badge ${SEVERITY_CLASS[r.flag.severity]}`}>{r.flag.severity}</span>{' '}
      <span className={`badge ${r.flag.status === 'unaddressed' ? 'badge-warn' : ''}`}>{label(r.flag.status)}</span>{' '}
      <span className="small faint">
        {showKind ? `${label(r.flag.kind)} · ` : ''}as {sideLabel(r.sideId)} · round {r.round}
      </span>
      <div>{r.flag.note}</div>
      {r.flag.resolution ? <div className="small muted">Resolution: {r.flag.resolution}</div> : null}
      {r.flag.status === 'unaddressed' ? (
        <Triage
          testId={`triage-rt-${r.flag.id}`}
          options={[
            { key: 'addressed', label: 'Addressed', placeholder: 'What you changed in the dive.' },
            { key: 'wont_fix', label: 'Won’t fix', placeholder: 'Why the step stays as it is.' },
          ]}
          onApply={(k, note) => update((d) => setBiasFlagStatus(d, r.reportIndex, r.flagIndex, k as 'addressed' | 'wont_fix', note))}
        />
      ) : (
        <Reopen what="red-team flag" onClick={() => update((d) => setBiasFlagStatus(d, r.reportIndex, r.flagIndex, 'unaddressed'))} />
      )}
    </li>
  );
}

export function HardQuestionItem({ q, sideLabel }: { q: Indexed<HardQuestion>; sideLabel: (id: string | undefined | null) => string }) {
  const { update } = useEditor();
  return (
    <li data-testid={`hard-question-${q.id}`}>
      <span className={`badge ${q.status === 'open' ? 'badge-warn' : ''}`}>{label(q.status)}</span>{' '}
      {q.blocking ? <span className="badge badge-error">blocking</span> : null}{' '}
      <span className="small faint">from {sideLabel(q.side_id)}&rsquo;s skeptic</span>
      <div>{q.question}</div>
      {q.resolution ? <div className="small muted">Resolution: {q.resolution}</div> : null}
      {q.status === 'open' ? (
        <Triage
          testId={`triage-hq-${q.id}`}
          options={[
            { key: 'answered', label: 'Answered', placeholder: 'Where the dive now answers it.' },
            { key: 'not_applicable', label: 'Not applicable', placeholder: 'Why the question does not apply.' },
          ]}
          onApply={(k, note) => update((d) => setHardQuestionStatus(d, q.index, k as 'answered' | 'not_applicable', note))}
        />
      ) : (
        <Reopen what="hard question" onClick={() => update((d) => setHardQuestionStatus(d, q.index, 'open'))} />
      )}
    </li>
  );
}

export function OpenIssueItem({ o, where }: { o: Indexed<OpenIssue>; where?: string }) {
  const { update } = useEditor();
  const cut = o.description.indexOf(RESOLVED_NOTE_PREFIX);
  const text = cut >= 0 ? o.description.slice(0, cut) : o.description;
  const note = cut >= 0 ? o.description.slice(cut + RESOLVED_NOTE_PREFIX.length) : null;
  return (
    <li data-testid={`open-issue-${o.id}`}>
      <span className={`badge ${o.resolved ? '' : SEVERITY_CLASS[o.severity]}`}>{o.resolved ? 'resolved' : o.severity}</span>{' '}
      <span className="small faint">
        {where ? `${where} · ` : ''}
        {label(o.source)}
      </span>
      <div>{text}</div>
      {note ? <div className="small muted">Resolved by the admin: {note}</div> : null}
      {!o.resolved ? (
        <Triage
          testId={`triage-oi-${o.id}`}
          options={[{ key: 'resolved', label: 'Mark resolved', placeholder: 'How it was resolved.' }]}
          onApply={(_k, n) => update((d) => setOpenIssueResolved(d, o.index, true, n))}
        />
      ) : (
        <Reopen what="open issue" onClick={() => update((d) => setOpenIssueResolved(d, o.index, false))} />
      )}
    </li>
  );
}

function ReaderFlags({ flags, stepId, sideLabel }: { flags: StepFlags; stepId: string; sideLabel: (id: string | undefined | null) => string }) {
  const { caseId, version, signalsVersion, busy } = useReview();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const u = flags.userFlags;
  if (!u) return null;
  const sv = signalsVersion ?? version;
  return (
    <>
      <div className="kicker">Reader flags{sv !== version ? ` · readers of v${sv}` : ''}</div>
      <ul className="flag-list">
        <li data-testid="reader-flags">
          <strong>{u.open}</strong> open of {u.total}
          {u.by_reason ? (
            <span className="small muted">
              {' '}
              ·{' '}
              {Object.entries(u.by_reason)
                .map(([k, n]) => `${label(k)} ${n}`)
                .join(', ')}
            </span>
          ) : null}
          {flags.userFlagsBySide.length ? (
            <div className="small muted">
              By the flagger&rsquo;s side: {flags.userFlagsBySide.map((s) => `${s.sideId === 'unrated' ? 'unrated' : sideLabel(s.sideId)} ${s.flags}`).join(', ')}
            </div>
          ) : null}
          {(u.notes ?? []).slice(0, 5).map((n, i) => (
            <div key={i} className="quote small">
              {n}
            </div>
          ))}
          {u.open > 0 ? (
            <div style={{ marginTop: 6 }}>
              <button
                type="button"
                className="btn btn-small"
                disabled={pending || busy}
                data-testid="mark-reader-flags-reviewed"
                onClick={() => {
                  if (!window.confirm(`Mark the ${u.open} open reader flag${u.open === 1 ? '' : 's'} on this step (v${sv}) as reviewed? This is saved right away.`)) return;
                  start(async () => {
                    try {
                      setResult(await resolveReaderFlags({ caseId, version: sv, stepId }));
                    } catch (e) {
                      setResult({ ok: false, error: `Could not reach the console (${(e as Error).message || 'network error'}). Try again.` });
                    }
                  });
                }}
              >
                {pending ? 'Saving…' : 'Mark reviewed'}
              </button>
            </div>
          ) : null}
          {result ? (
            <div className={`small ${result.ok ? 'muted' : ''}`} role={result.ok ? 'status' : 'alert'} style={result.ok ? undefined : { color: 'var(--error)' }}>
              {result.ok ? result.message : result.error}
            </div>
          ) : null}
        </li>
      </ul>
    </>
  );
}

function AlertsList({ alerts }: { alerts: StepFlags['alerts'] }) {
  if (!alerts.length) return null;
  return (
    <>
      <div className="kicker">Alerts</div>
      <ul className="flag-list">
        {alerts.map((a) => (
          <li key={a.id}>
            <span className={`badge ${a.resolved_at ? '' : 'badge-warn'}`}>{a.resolved_at ? 'resolved' : 'open'}</span> {a.kind} alert raised {formatDateTime(a.created_at)}
            {a.resolution ? <div className="small muted">{a.resolution}</div> : null}
            {!a.resolved_at ? <ResolveAlertForm alertId={a.id} /> : null}
          </li>
        ))}
      </ul>
    </>
  );
}

const sideLabelOf = (sides: Side[]) => (id: string | undefined | null) => (id ? (sides.find((s) => s.id === id)?.label || id) : 'any side');

/** Everything flagged on one step: fact-checker, red teams, hard questions, open issues, readers. */
export const FlagsPanel = memo(function FlagsPanel({ flags, sides, stepId }: { flags: StepFlags | undefined; sides: Side[]; stepId: string }) {
  if (!flags) return null;
  const sideLabel = sideLabelOf(sides);
  const empty =
    !flags.factCheck.length && !flags.redTeam.length && !flags.hardQuestions.length && !flags.openIssues.length && !flags.userFlags && !flags.alerts.length;
  if (empty) return <p className="small faint" style={{ marginTop: 12 }}>No fact-checker, red-team or reader flags on this step.</p>;
  return (
    <div className="flags" data-testid="step-flags">
      <h4>
        Flags {flags.attention ? <span className="badge badge-warn">{flags.attention} need attention</span> : <span className="badge">all handled</span>}
      </h4>
      {flags.factCheck.length ? (
        <>
          <div className="kicker">Fact-checker</div>
          <ul className="flag-list">
            {flags.factCheck.map((f) => (
              <FactCheckItem key={f.index} f={f} stepId={stepId} />
            ))}
          </ul>
        </>
      ) : null}
      {flags.redTeam.length ? (
        <>
          <div className="kicker">Red team</div>
          <ul className="flag-list">
            {flags.redTeam.map((r) => (
              <RedTeamItem key={`${r.reportIndex}:${r.flagIndex}`} r={r} sideLabel={sideLabel} />
            ))}
          </ul>
        </>
      ) : null}
      {flags.hardQuestions.length ? (
        <>
          <div className="kicker">Hard questions</div>
          <ul className="flag-list">
            {flags.hardQuestions.map((q) => (
              <HardQuestionItem key={q.index} q={q} sideLabel={sideLabel} />
            ))}
          </ul>
        </>
      ) : null}
      {flags.openIssues.length ? (
        <>
          <div className="kicker">Open issues</div>
          <ul className="flag-list">
            {flags.openIssues.map((o) => (
              <OpenIssueItem key={o.index} o={o} />
            ))}
          </ul>
        </>
      ) : null}
      <ReaderFlags flags={flags} stepId={stepId} sideLabel={sideLabel} />
      <AlertsList alerts={flags.alerts} />
    </div>
  );
});

/** Review items not tied to any current step (the whole case, a side, or a step that was removed). */
export const CaseFlags = memo(function CaseFlags({ flags, sides }: { flags: CaseLevelFlags; sides: Side[] }) {
  const sideLabel = sideLabelOf(sides);
  if (flags.redTeam.length + flags.hardQuestions.length + flags.openIssues.length + flags.factCheck.length === 0) {
    return <div id={CASE_FLAGS_ID} tabIndex={-1} />;
  }
  return (
    <div className="flags" style={{ marginBottom: 14 }} id={CASE_FLAGS_ID} tabIndex={-1} data-testid="case-flags">
      <h4>Flags on the whole case</h4>
      <ul className="flag-list">
        {flags.factCheck.map((f) => (
          <FactCheckItem key={`fc${f.index}`} f={f} />
        ))}
        {flags.redTeam.map((r) => (
          <RedTeamItem key={`rt${r.reportIndex}:${r.flagIndex}`} r={r} sideLabel={sideLabel} />
        ))}
        {flags.hardQuestions.map((q) => (
          <HardQuestionItem key={`hq${q.index}`} q={q} sideLabel={sideLabel} />
        ))}
        {flags.openIssues.map((o) => (
          <OpenIssueItem key={`oi${o.index}`} o={o} where={o.step_id ? `step ${o.step_id} (not in this version)` : 'whole case'} />
        ))}
      </ul>
    </div>
  );
});
