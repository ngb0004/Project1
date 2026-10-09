'use client';

import { startTransition, useActionState, useState } from 'react';
import { setCadenceAction } from '@/app/(console)/actions';
import { CADENCE_CHOICES, cadenceChoiceOf } from '@/lib/format';
import { IDLE } from '@/lib/form-state';
import { FormMessage } from './ActionForm';

/** Re-research cadence picker. Controlled, so it keeps showing the saved choice after the action. */
export function CadenceForm({ caseId, current }: { caseId: string; current: string | null }) {
  const initial = cadenceChoiceOf(current);
  const [choice, setChoice] = useState<string>(initial === 'custom' ? '' : initial);
  const [state, action, pending] = useActionState(setCadenceAction, IDLE);
  return (
    <form
      data-testid="cadence-form"
      onSubmit={(e) => {
        // Dispatched by hand: a form `action` would reset the form, and the select with it, after saving.
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        startTransition(() => action(data));
      }}
    >
      <input type="hidden" name="caseId" value={caseId} />
      <div className="row">
        <select name="cadence" value={choice} onChange={(e) => setChoice(e.target.value)} aria-label="Cadence" style={{ width: 'auto' }} required>
          {initial === 'custom' ? <option value="">Custom ({current})</option> : null}
          {CADENCE_CHOICES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button type="submit" className="btn btn-primary" disabled={pending || choice === ''}>
          {pending ? 'Saving…' : 'Save cadence'}
        </button>
      </div>
      <FormMessage state={state} />
    </form>
  );
}
