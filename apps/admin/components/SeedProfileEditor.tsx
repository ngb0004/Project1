'use client';

import { startTransition, useActionState, useMemo, useState } from 'react';
import { SeedProfile } from '@sia/case-schema';
import { saveSeedProfileAction } from '@/app/(console)/actions';
import { IDLE } from '@/lib/form-state';
import { FormMessage } from './ActionForm';

const EXAMPLE = {
  sessions: 400,
  before_bins: [2, 3, 5, 8, 12, 14, 16, 16, 14, 10],
  steps: {},
  fade_after_real_completions: 500,
  rng_seed: 1,
  note: 'Where this estimate comes from.',
};

/**
 * JSON editor for the case's seed profile, checked live against the shared
 * SeedProfile schema. The server checks it again before saving.
 */
export function SeedProfileEditor({
  caseId,
  initial,
  stepIds,
}: {
  caseId: string;
  initial: unknown;
  /** Step ids of the live version, to point out profile entries that match no step. */
  stepIds: string[];
}) {
  const [text, setText] = useState(() => (initial ? JSON.stringify(initial, null, 2) : ''));
  const [state, action, pending] = useActionState(saveSeedProfileAction, IDLE);

  const check = useMemo(() => {
    if (!text.trim()) return { ok: true as const, note: 'Empty: saving clears the profile (no seeded crowd).', warnings: [] as string[] };
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      return { ok: false as const, errors: [`Not valid JSON: ${(e as Error).message}`] };
    }
    const parsed = SeedProfile.safeParse(raw);
    if (!parsed.success) {
      return { ok: false as const, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(profile)'}: ${i.message}`) };
    }
    const warnings: string[] = [];
    const unknown = Object.keys(parsed.data.steps).filter((id) => !stepIds.includes(id));
    if (unknown.length) warnings.push(`No step in the live version has id ${unknown.map((s) => `"${s}"`).join(', ')}; those entries are ignored.`);
    const missing = stepIds.filter((id) => !(id in parsed.data.steps));
    if (stepIds.length && missing.length) warnings.push(`No vote mix for ${missing.join(', ')}: seeded votes there split evenly.`);
    return { ok: true as const, note: `${parsed.data.sessions} seeded sessions; seeds fade out by ${parsed.data.fade_after_real_completions} real completions.`, warnings };
  }, [text, stepIds]);

  return (
    <form
      data-testid="seed-form"
      onSubmit={(e) => {
        // Dispatched by hand: a form `action` would reset the textarea after saving.
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        startTransition(() => action(data));
      }}
    >
      <input type="hidden" name="caseId" value={caseId} />
      <label className="field">
        <span className="field-label">Seed profile (JSON)</span>
        <textarea
          name="profile"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={12}
          spellCheck={false}
          className={`mono ${check.ok ? '' : 'input-invalid'}`}
          aria-describedby="seed-check"
        />
      </label>
      <div id="seed-check" className="small" aria-live="polite">
        {check.ok ? (
          <>
            <p className="muted">{check.note}</p>
            {check.warnings.map((w) => (
              <p key={w} className="notice notice-warn small">
                {w}
              </p>
            ))}
          </>
        ) : (
          <ul className="field-issues">
            {check.errors.map((e) => (
              <li key={e} className="issue-error">
                {e}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button type="submit" className="btn btn-primary" disabled={pending || !check.ok}>
          {pending ? 'Saving…' : 'Save seed profile'}
        </button>
        {!text.trim() ? null : (
          <button type="button" className="btn-link small" onClick={() => setText('')}>
            Clear
          </button>
        )}
        {text.trim() ? null : (
          <button type="button" className="btn-link small" onClick={() => setText(JSON.stringify(EXAMPLE, null, 2))}>
            Start from an example
          </button>
        )}
      </div>
      <FormMessage state={state} />
    </form>
  );
}
