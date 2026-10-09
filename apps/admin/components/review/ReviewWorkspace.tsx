'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from 'react';
import { deepEqual, toPublicCase, validateCase, type Case, type PublicCase, type SeedProfileInput } from '@sia/case-schema';
import { saveEdits } from '@/app/(console)/review/actions';
import { SESSION_ENDED_HINT } from '@/lib/errors-client';
import type { ActionResult } from '@/lib/form-state';
import { humanizeValidation, isReviewMismatch, issueLabel } from '@/lib/issues';
import { isEditable, reviewActions } from '@/lib/review-actions';
import { combineNotes, describeTriage } from '@/lib/review-triage';
import {
  attentionReasons,
  caseLevelAttention,
  collectCaseLevelFlags,
  collectFactFlags,
  collectStepFlags,
  publishCautions,
  type StepFlags,
  type UserSignals,
} from '@/lib/step-flags';
import { addStep, contentOf, isContentDirty, isDirty, reviewEditsOf, setAt, setOptionalText, withManagedFields, type Doc, type Path } from '@/lib/working-copy';
import { ActionsPanel, type RunWrite } from './ActionsPanel';
import { BalancePanel } from './BalancePanel';
import { CaseCardEditor, OpenQuestionsEditor, SidesEditor, SourcesEditor, TakesEditor, TimelineEditor, StartingFactsEditor } from './CaseEditors';
import { DiffView } from './DiffView';
import { EditorContext, EditorStore, IssueIndex, ReviewContext, type EditorApi, type ReviewContextValue } from './editor-context';
import { CaseFlags } from './FlagsPanel';
import { ReaderSignalsPanel } from './ReaderSignals';
import { Preview, jumpToIssue, revealElement } from './Preview';
import type { PreviewHistory } from './PreviewPlayer';
import { StepCard } from './StepCard';

export interface ReviewMeta {
  caseId: string;
  slug: string;
  version: number;
  status: Case['status'];
  origin: 'pipeline' | 'admin' | 'import';
  tags: string[];
  parentVersion: number | null;
  liveVersion: number | null;
  isLive: boolean;
  scheduledAt: string | null;
  existingDraft: number | null;
}

export interface CompareTarget {
  key: string;
  label: string;
  doc: Case;
}

function previewOf(doc: Doc, saved: Case): PublicCase | null {
  const v = validateCase(withManagedFields(doc, saved));
  return v.ok && v.case ? toPublicCase(v.case) : null;
}

/** FNV-1a, for "is this autosaved copy based on the same saved version?" (not security). */
function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

interface Autosaved {
  savedHash: string;
  at: string;
  working: Doc;
}

const storage = {
  read(key: string): Autosaved | null {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as Autosaved) : null;
    } catch {
      return null;
    }
  },
  write(key: string, v: Autosaved) {
    try {
      window.localStorage.setItem(key, JSON.stringify(v));
    } catch {
      // Storage full or blocked: the beforeunload and navigation prompts still guard the edits.
    }
  },
  remove(key: string) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // ignore
    }
  },
};

const LEAVE_PROMPT = 'You have unsaved edits on this review. Leave without saving?\n\n(A copy stays in this browser and is offered when you come back.)';

const networkError = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  if (/unexpected response/i.test(m)) return SESSION_ENDED_HINT;
  return `The console could not be reached (${m || 'network error'}). Nothing was lost: your edits are still here. Try again.`;
};

export function ReviewWorkspace({
  meta,
  saved,
  compareTargets,
  seedProfile,
  signals,
  shareBaseUrl,
  previewHistory,
  audit,
}: {
  meta: ReviewMeta;
  saved: Case;
  compareTargets: CompareTarget[];
  seedProfile: SeedProfileInput | null;
  signals: UserSignals | null;
  shareBaseUrl: string | null;
  previewHistory: PreviewHistory | null;
  audit: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const rootRef = useRef<HTMLDivElement>(null);
  const readOnly = !isEditable(meta.status, meta.isLive);
  // The live version is edited like a package, but its edits are saved as a new admin_edit draft.
  const editsMakeDraft = meta.status === 'published' && !readOnly;

  // One write at a time across the screen: the savebar and every action share this.
  const [busy, startBusy] = useTransition();
  const run: RunWrite = useCallback((fn, after) => {
    startBusy(async () => {
      let r: ActionResult;
      try {
        r = await fn();
      } catch (e) {
        r = { ok: false, error: networkError(e) };
      }
      after?.(r);
    });
  }, []);

  const [store] = useState(() => new EditorStore(saved, readOnly));
  const working = useSyncExternalStore(store.subscribe, store.getDoc, store.getDoc);
  const setWorking = useCallback((d: Doc) => store.setDoc(d), [store]);
  const editor: EditorApi = useMemo(
    () => ({
      store,
      set: (path: Path, value: unknown) => store.updateDoc((d) => setAt(d, path, value)),
      setOptional: (path: Path, value: string) => store.updateDoc((d) => setOptionalText(d, path, value)),
      update: (fn: (d: Doc) => Doc) => store.updateDoc(fn),
    }),
    [store],
  );
  useEffect(() => store.setReadOnly(readOnly || busy), [store, readOnly, busy]);

  const [baseline, setBaseline] = useState<Case>(saved);
  const [previewFrom, setPreviewFrom] = useState<Doc>(saved);
  const [previewDoc, setPreviewDoc] = useState<PublicCase | null>(() => previewOf(saved, saved));
  const [runKey, setRunKey] = useState(1);
  const [compareKey, setCompareKey] = useState<string>(compareTargets[0]?.key ?? 'saved');
  const [saveResult, setSaveResult] = useState<ActionResult | null>(null);

  // A review action re-renders the page with a new saved document (a decision
  // appended, a status change). Keep the admin's edits, take the rest; once the
  // version is final (rejected, sent back, archived), the edits have nowhere to go.
  useEffect(() => {
    if (saved === baseline) return;
    const keep = !readOnly && isDirty(baseline, working);
    const next = keep ? withManagedFields(working, saved) : saved;
    setWorking(next);
    setBaseline(saved);
    // The saved content itself changed (e.g. edits were just saved or published): replay the preview from it.
    if (!isContentDirty(saved, next) && isContentDirty(previewFrom, saved)) {
      setPreviewDoc(previewOf(saved, saved));
      setPreviewFrom(saved);
      setRunKey((k) => k + 1);
    }
  }, [saved, baseline, working, previewFrom, readOnly, setWorking]);

  const deferred = useDeferredValue(working);
  const effective = useMemo(() => withManagedFields(deferred, saved), [deferred, saved]);
  const validation = useMemo(() => humanizeValidation(validateCase(effective), effective), [effective]);
  const savedValidation = useMemo(() => validateCase(saved), [saved]);
  useEffect(() => store.setIssues(new IssueIndex(validation.errors, validation.warnings)), [store, validation]);
  const dirty = isDirty(saved, working);

  // ---- Unsaved edits: reload/close prompt, in-app navigation prompt, local autosave ----

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    // Client-side navigation (Next links, the Sign out form) never fires beforeunload: ask first.
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      let url: URL;
      try {
        url = new URL(a.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin === window.location.origin && url.pathname === window.location.pathname && url.search === window.location.search) return;
      if (!window.confirm(LEAVE_PROMPT)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onSubmit = (e: SubmitEvent) => {
      const form = e.target as HTMLFormElement | null;
      if (form && rootRef.current?.contains(form)) return;
      if (!window.confirm(LEAVE_PROMPT)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', warn);
    window.addEventListener('click', onClick, true);
    window.addEventListener('submit', onSubmit, true);
    return () => {
      window.removeEventListener('beforeunload', warn);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('submit', onSubmit, true);
    };
  }, [dirty]);

  const storageKey = `sia-admin:working:${meta.caseId}:${meta.version}`;
  const savedHash = useMemo(() => hashString(JSON.stringify([contentOf(saved), reviewEditsOf(saved)])), [saved]);
  const [restore, setRestore] = useState<Autosaved | null>(null);
  const [restoreChecked, setRestoreChecked] = useState(false);
  useEffect(() => {
    if (readOnly) {
      storage.remove(storageKey);
      setRestoreChecked(true);
      return;
    }
    const found = storage.read(storageKey);
    if (found && found.savedHash === savedHash && found.working && isDirty(saved, found.working)) setRestore(found);
    else if (found) storage.remove(storageKey);
    setRestoreChecked(true);
    // Checked once, when the screen opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!restoreChecked || restore || readOnly) return;
    const t = window.setTimeout(() => {
      if (dirty) storage.write(storageKey, { savedHash, at: new Date().toISOString(), working });
      else storage.remove(storageKey);
    }, 400);
    return () => window.clearTimeout(t);
  }, [working, dirty, restore, restoreChecked, readOnly, savedHash, storageKey]);

  // ---- Links to steps (audit tabs, balance strip, needs-attention list) follow the working copy ----

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[data-step-id]');
      if (!a) return;
      const id = a.getAttribute('data-step-id');
      const i = (store.getDoc().steps ?? []).findIndex((s) => s.id === id);
      if (i < 0) return;
      const el = document.getElementById(`f-steps-${i}`);
      if (!el) return;
      e.preventDefault();
      revealElement(el);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [store]);

  // A notice in the URL (?notice=saved) is about the moment it was set; drop it once another action runs.
  const clearNotice = useCallback(() => {
    if (searchParams.get('notice')) router.replace(pathname, { scroll: false });
  }, [searchParams, router, pathname]);

  // Keep each step's flags object while its content is the same, so memoized step cards skip re-rendering.
  const flagsCache = useRef(new Map<string, StepFlags>());
  const stepFlags = useMemo(() => {
    const next = collectStepFlags(effective, signals);
    for (const [id, f] of next) {
      const prev = flagsCache.current.get(id);
      if (prev && deepEqual(prev, f)) next.set(id, prev);
    }
    flagsCache.current = next;
    return next;
  }, [effective, signals]);
  const factFlags = useMemo(() => collectFactFlags(effective), [effective]);
  const caseLevel = useMemo(() => collectCaseLevelFlags(effective), [effective]);
  const cautions = useMemo(() => publishCautions(dirty ? effective : saved), [dirty, effective, saved]);
  const actions = reviewActions({
    status: meta.status,
    origin: meta.origin,
    tags: meta.tags,
    version: meta.version,
    scheduledAt: meta.scheduledAt,
    isLive: meta.isLive,
    parentVersion: meta.parentVersion,
    liveVersion: meta.liveVersion,
    errors: validation.errors.length,
    savedErrors: savedValidation.errors.length,
    dirty,
  });

  const restartPreview = useCallback(() => {
    const current = store.getDoc();
    setPreviewDoc(previewOf(current, saved));
    setPreviewFrom(current);
    setRunKey((k) => k + 1);
  }, [store, saved]);

  const getWorkingDoc = useCallback(() => withManagedFields(store.getDoc(), saved), [store, saved]);
  const getTriage = useCallback(() => describeTriage(saved, store.getDoc()), [store, saved]);
  const steps = working.steps ?? [];
  const sides = working.sides ?? [];
  const stepIdsKey = JSON.stringify(steps.map((s) => s.id));
  const stepIds = useMemo(() => JSON.parse(stepIdsKey) as string[], [stepIdsKey]);

  const targets: CompareTarget[] = dirty ? [...compareTargets, { key: 'saved', label: `Saved v${meta.version}`, doc: saved }] : compareTargets;
  const target = targets.find((t) => t.key === compareKey) ?? targets[0];
  const showsBadge = (n: number, cls: string, what: string) => (n ? <span className={`badge ${cls}`}>{`${n} ${what}${n === 1 ? '' : 's'}`}</span> : null);

  const needs = useMemo(
    () =>
      (effective.steps ?? []).flatMap((s, i) => {
        const f = stepFlags.get(s.id);
        const reasons = f && f.attention ? attentionReasons(f, s.confidence) : [];
        return reasons.length ? [{ i, id: s.id, order: s.order, headline: s.headline, reasons }] : [];
      }),
    [effective, stepFlags],
  );
  const caseAttention = caseLevelAttention(caseLevel);

  const onNavigate = (href: string, notice: 'saved' | 'published') => {
    storage.remove(storageKey);
    router.push(`${href}?notice=${notice}`);
  };

  const save = () => {
    if (meta.existingDraft && meta.status !== 'draft' && !window.confirm(`Replace the content of draft v${meta.existingDraft} with this working copy?`)) return;
    setSaveResult(null);
    run(
      () => saveEdits({ caseId: meta.caseId, version: meta.version, doc: getWorkingDoc(), notes: combineNotes('', getTriage()) }),
      (r) => {
        setSaveResult(r);
        if (r.ok && r.href) onNavigate(r.href, 'saved');
      },
    );
  };

  const reviewCtx: ReviewContextValue = useMemo(
    () => ({ caseId: meta.caseId, version: meta.version, canEdit: !readOnly && !busy, signalsVersion: signals?.version ?? null, busy }),
    [meta.caseId, meta.version, readOnly, busy, signals?.version],
  );

  const issueRows = [...validation.errors.map((i) => ({ i, kind: 'error' as const })), ...validation.warnings.map((i) => ({ i, kind: 'warning' as const }))];
  const openChecks = validation.errors.length > 0 || validation.warnings.some(isReviewMismatch);

  return (
    <EditorContext.Provider value={editor}>
      <ReviewContext.Provider value={reviewCtx}>
        <div ref={rootRef}>
          {restore ? (
            <div className="notice notice-warn" role="alert" data-testid="restore-banner" style={{ marginBottom: 16 }}>
              <strong>Unsaved edits from {new Date(restore.at).toLocaleString()}</strong> were kept in this browser for this version.{' '}
              <span className="row" style={{ display: 'inline-flex', marginLeft: 8 }}>
                <button
                  type="button"
                  className="btn btn-small btn-primary"
                  data-testid="restore-edits"
                  onClick={() => {
                    setWorking(withManagedFields(restore.working, saved));
                    setRestore(null);
                  }}
                >
                  Restore them
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => {
                    if (!window.confirm('Discard the kept edits? This cannot be undone.')) return;
                    storage.remove(storageKey);
                    setRestore(null);
                  }}
                >
                  Discard
                </button>
              </span>
            </div>
          ) : null}

          {needs.length || caseAttention ? (
            <section className="panel needs" aria-labelledby="needs-h" data-testid="needs-attention">
              <h3 id="needs-h" style={{ margin: 0 }}>
                Needs attention{' '}
                <span className="small faint">
                  {needs.length ? `${needs.length} step${needs.length === 1 ? '' : 's'}` : ''}
                  {needs.length && caseAttention ? ' · ' : ''}
                  {caseAttention ? `${caseAttention} item${caseAttention === 1 ? '' : 's'} on the whole case` : ''}
                </span>
              </h3>
              <ul className="needs-list">
                {needs.map((n) => (
                  <li key={n.id}>
                    <a href={`#f-steps-${n.i}`} data-step-id={n.id}>
                      Step {n.order}
                    </a>{' '}
                    <span className="muted">{n.headline || 'Untitled step'}</span> <span className="small">— {n.reasons.join('; ')}</span>
                  </li>
                ))}
                {caseAttention ? (
                  <li>
                    <a
                      href="#case-flags"
                      onClick={(e) => {
                        const el = document.getElementById('case-flags');
                        if (!el) return;
                        e.preventDefault();
                        revealElement(el);
                      }}
                    >
                      Whole case
                    </a>{' '}
                    <span className="small">— review items not tied to one step</span>
                  </li>
                ) : null}
              </ul>
            </section>
          ) : null}

          {signals ? <ReaderSignalsPanel signals={signals} sides={sides} thisVersion={meta.version} /> : null}

          <section className="checks panel" aria-labelledby="checks-h" data-testid="checks">
            <div className="row-between">
              <h3 id="checks-h" style={{ margin: 0 }}>
                Checks <span className="small faint">validateCase on the {dirty ? 'working copy (unsaved edits)' : 'saved version'}</span>
              </h3>
              <span className="row">
                {validation.errors.length ? showsBadge(validation.errors.length, 'badge-error', 'error') : <span className="badge badge-ok" data-testid="checks-ok">No errors: publishable</span>}
                {showsBadge(validation.warnings.length, 'badge-warn', 'warning')}
                {dirty ? <span className="badge badge-info">Unsaved edits</span> : null}
                {readOnly ? <span className="badge">Read-only ({meta.status.replace('_', ' ')})</span> : null}
                {editsMakeDraft ? <span className="badge">Live: edits are saved as a new draft</span> : null}
              </span>
            </div>
            {issueRows.length > 0 ? (
              <details open={openChecks} key={openChecks ? 'open' : 'closed'}>
                <summary className="small muted" style={{ marginTop: 8 }}>
                  {validation.errors.length ? 'Errors block publishing. ' : ''}Warnings are shown but do not block. Click an item to jump to the field.
                </summary>
                <ul className="issue-list" data-testid="issue-list">
                  {issueRows.map(({ i, kind }, n) => (
                    <li key={n}>
                      <span className={`badge ${kind === 'error' ? 'badge-error' : 'badge-warn'}`}>{kind}</span>{' '}
                      <button type="button" className="btn-link" onClick={() => jumpToIssue(i.path, working)} title={i.path}>
                        <span className="path">{issueLabel(i.path, working)}</span>
                      </button>{' '}
                      {i.message}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </section>

          <div className="review-layout">
            <aside className="review-side section" aria-labelledby="preview-h">
              <header>
                <h2 id="preview-h">
                  <span className="section-num">2</span>Preview
                </h2>
                <span className="small muted">as a reader sees it</span>
              </header>
              <Preview
                doc={previewDoc}
                errors={validation.errors}
                stale={!validation.errors.length && isContentDirty(previewFrom, working)}
                seedProfile={seedProfile}
                shareBaseUrl={shareBaseUrl}
                history={previewHistory}
                runKey={runKey}
                onRestart={restartPreview}
                workingDoc={working}
              />
            </aside>

            <div>
              <section className="section" aria-labelledby="steps-h">
                <header>
                  <h2 id="steps-h">
                    <span className="section-num">3</span>Facts and steps
                  </h2>
                  <span className="small muted" data-testid="edit-mode">
                    {readOnly
                      ? meta.status === 'published'
                        ? `Published versions never change, and this one is not live: edit the live version${meta.liveVersion ? ` (v${meta.liveVersion})` : ''} instead.`
                        : 'This version is final and read-only.'
                      : editsMakeDraft
                        ? 'Every field is editable inline. This published version never changes: saving creates a new draft (tagged admin_edit) that you approve.'
                        : 'Every field is editable inline. Marking review items (flags, questions, issues) is saved with your edits.'}
                  </span>
                </header>
                <CaseCardEditor />
                <CaseFlags flags={caseLevel} sides={sides} />
                <StartingFactsEditor factFlags={factFlags} />
                <div className="row-between" style={{ marginTop: 24 }}>
                  <h3 style={{ margin: 0 }} id="f-steps" tabIndex={-1}>
                    Steps ({steps.length})
                  </h3>
                  <span className="row small">
                    <button type="button" className="btn btn-small" onClick={() => setCardsOpen(rootRef.current, false)} data-testid="collapse-steps">
                      Collapse all
                    </button>
                    <button type="button" className="btn btn-small" onClick={() => setCardsOpen(rootRef.current, true)}>
                      Expand all
                    </button>
                  </span>
                </div>
                <nav className="step-index" aria-label="Steps">
                  {steps.map((s, i) => {
                    const att = stepFlags.get(s.id)?.attention ?? 0;
                    return (
                      <a key={`${i}:${s.id}`} href={`#f-steps-${i}`} data-step-id={s.id} className={att ? 'has-attention' : ''} title={s.headline}>
                        {s.order}
                        {att ? <span className="dot" aria-label={`${att} need attention`} /> : null}
                      </a>
                    );
                  })}
                </nav>
                {steps.map((s, i) => (
                  <StepCard key={`${i}:${s.id}`} step={s} index={i} count={steps.length} sides={sides} flags={stepFlags.get(s.id)} stepIds={stepIds} />
                ))}
                {readOnly ? null : (
                  <button type="button" className="btn" onClick={() => editor.update((d) => addStep(d).doc)} style={{ marginBottom: 24 }} disabled={busy}>
                    + Add step at the end
                  </button>
                )}
                <SidesEditor />
                <TimelineEditor />
                <TakesEditor />
                <OpenQuestionsEditor />
                <SourcesEditor />
              </section>

              <section className="section" aria-labelledby="balance-h">
                <header>
                  <h2 id="balance-h">
                    <span className="section-num">4</span>Balance
                  </h2>
                  <span className="small muted">from the {dirty ? 'working copy' : 'saved version'}</span>
                </header>
                <BalancePanel doc={effective} />
              </section>

              <section className="section" aria-labelledby="audit-h">
                <header>
                  <h2 id="audit-h">
                    <span className="section-num">5</span>Audit
                  </h2>
                  <span className="small muted">how every fact got in (as saved in v{meta.version})</span>
                </header>
                {audit}
              </section>

              <section className="section" aria-labelledby="diff-h" id="diff">
                <header>
                  <h2 id="diff-h">
                    <span className="section-num">6</span>Changes
                  </h2>
                  {targets.length > 1 ? (
                    <label className="row small">
                      Compare with
                      <select value={target?.key} onChange={(e) => setCompareKey(e.target.value)} style={{ width: 'auto' }} data-testid="compare-select">
                        {targets.map((t) => (
                          <option key={t.key} value={t.key}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </header>
                {target ? (
                  <DiffView before={target.doc} after={effective} beforeLabel={target.label} afterLabel={dirty ? 'Working copy (unsaved)' : `This version (v${meta.version})`} />
                ) : (
                  <p className="empty">This is the case&rsquo;s first version: there is no live or base version to compare against.</p>
                )}
              </section>

              <section className="section" aria-labelledby="actions-h" id="actions">
                <header>
                  <h2 id="actions-h">
                    <span className="section-num">7</span>Decision
                  </h2>
                </header>
                <ActionsPanel
                  meta={{ caseId: meta.caseId, version: meta.version, scheduledAt: meta.scheduledAt, existingDraft: meta.existingDraft, isAdminDraft: meta.status === 'draft' && meta.origin === 'admin' }}
                  actions={actions}
                  getWorkingDoc={getWorkingDoc}
                  getTriage={getTriage}
                  cautions={cautions}
                  dirty={dirty}
                  run={run}
                  busy={busy}
                  onNavigate={onNavigate}
                  onSettled={clearNotice}
                />
              </section>
            </div>
          </div>

          {dirty ? (
            <div className="savebar" role="region" aria-label="Unsaved edits" data-testid="savebar">
              <span className="msg">
                Unsaved edits{editsMakeDraft ? ' to the live version (saving creates a new draft)' : ''}
                {validation.errors.length ? ` · ${validation.errors.length} error${validation.errors.length === 1 ? '' : 's'} to fix before saving` : ''}
              </span>
              {saveResult && !saveResult.ok ? (
                <span className="small" style={{ color: 'var(--error)' }} role="alert" data-testid="savebar-error">
                  {saveResult.error}
                </span>
              ) : !actions.save_edit.enabled && actions.save_edit.reason && !validation.errors.length ? (
                <span className="small muted">{actions.save_edit.reason}</span>
              ) : null}
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => {
                  if (window.confirm('Discard all unsaved edits?')) {
                    setWorking(saved);
                    setSaveResult(null);
                  }
                }}
              >
                Discard edits
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!actions.save_edit.enabled || busy}
                title={actions.save_edit.reason ?? undefined}
                data-testid="savebar-save"
                onClick={save}
              >
                {busy ? 'Saving…' : 'Save edits'}
              </button>
              <a href="#actions" className="small">
                Go to decision
              </a>
            </div>
          ) : null}
        </div>
      </ReviewContext.Provider>
    </EditorContext.Provider>
  );
}

function setCardsOpen(root: HTMLElement | null, open: boolean) {
  root?.querySelectorAll<HTMLDetailsElement>('details.step-card').forEach((d) => {
    d.open = open;
  });
}
