'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import type { Issue, PublicCase, SeedProfileInput } from '@sia/case-schema';
import { CASE_FLAGS_ID, issueLabel, issueTargetPath } from '@/lib/issues';
import { domIdCandidates, type Doc } from '@/lib/working-copy';
import type { PreviewHistory } from './PreviewPlayer';

const PreviewPlayer = dynamic(() => import('./PreviewPlayer'), {
  ssr: false,
  loading: () => <p className="phone-errors muted">Loading the preview…</p>,
});

/** Opens collapsed cards around `el`, scrolls it to the middle of the screen and focuses it. */
export function revealElement(el: HTMLElement) {
  let p: HTMLElement | null = el;
  while (p) {
    if (p instanceof HTMLDetailsElement) p.open = true;
    p = p.parentElement;
  }
  // Wait a frame so a card that just opened has laid out its fields. A tall
  // target (a whole step card) is aligned to its top, just below the top bar.
  requestAnimationFrame(() => {
    const tall = el.getBoundingClientRect().height > window.innerHeight * 0.6;
    el.scrollIntoView({ behavior: 'smooth', block: tall ? 'start' : 'center' });
    el.focus({ preventScroll: true });
  });
}

/**
 * Scrolls to the field behind a validation issue. Issues in the review record
 * (a fact-check row, a red-team flag, a hard question) jump to the step, fact,
 * layer or side they are about, or to the case-level flags.
 */
export function jumpToIssue(path: string, doc?: Partial<Doc>) {
  const target = doc ? issueTargetPath(path, doc) : path;
  const ids = target === CASE_FLAGS_ID ? [CASE_FLAGS_ID] : [...domIdCandidates(target), 'f-steps'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    revealElement(el);
    return;
  }
}

/**
 * The phone-sized preview. When the working copy fails validation, the last
 * valid run stays where the admin left it, under a notice listing the errors
 * (the app would refuse to play the document as it is now).
 */
export function Preview({
  doc,
  errors,
  stale,
  seedProfile,
  shareBaseUrl,
  history,
  runKey,
  onRestart,
  workingDoc,
}: {
  doc: PublicCase | null;
  errors: Issue[];
  /** The working copy changed since this preview started. */
  stale: boolean;
  seedProfile: SeedProfileInput | null;
  shareBaseUrl: string | null;
  history: PreviewHistory | null;
  runKey: number;
  onRestart: () => void;
  /** For readable issue labels and jump targets. */
  workingDoc: Partial<Doc>;
}) {
  const [seedProblem, setSeedProblem] = useState<string | null>(null);
  const errorList = (
    <ul className="issue-list">
      {errors.map((e, i) => (
        <li key={i}>
          <button type="button" className="btn-link" onClick={() => jumpToIssue(e.path, workingDoc)}>
            <span className="path">{issueLabel(e.path, workingDoc)}</span>
          </button>{' '}
          {e.message}
        </li>
      ))}
    </ul>
  );
  return (
    <div data-testid="preview">
      <div className="phone" aria-label="Dive preview, phone sized">
        {doc ? (
          <PreviewPlayer
            doc={doc}
            seedProfile={seedProfile}
            shareBaseUrl={shareBaseUrl}
            history={history}
            runKey={runKey}
            onExit={onRestart}
            onSeedProblem={setSeedProblem}
          />
        ) : null}
        {errors.length > 0 || !doc ? (
          <div className={doc ? 'phone-overlay' : 'phone-errors'} data-testid="preview-errors" role="status">
            <h3>{doc ? 'The working copy can’t play right now' : 'Can’t preview yet'}</h3>
            <p className="muted small">
              {errors.length} validation error{errors.length === 1 ? '' : 's'}: the app would refuse to play it.
              {doc ? ' The run below is the last valid version; it stays where you left it.' : ''}
            </p>
            {errorList}
          </div>
        ) : null}
      </div>
      <div className="preview-bar">
        <span className="small muted">
          {errors.length ? 'Fix the errors to play your edits.' : stale ? 'You edited since this run started.' : seedProfile ? 'Seeded crowd from the case’s seed profile.' : 'No seed profile: crowd reveals start empty.'}
        </span>
        <button type="button" className={`btn btn-small ${stale && !errors.length ? 'btn-primary' : ''}`} onClick={onRestart} disabled={errors.length > 0} data-testid="restart-preview">
          Restart preview
        </button>
      </div>
      {seedProblem ? <p className="notice notice-warn small" style={{ marginTop: 8 }}>{seedProblem}</p> : null}
    </div>
  );
}
