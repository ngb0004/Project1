'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { IDLE, errorState, type FormState } from '@/lib/form-state';

/** Next.js signals redirects and not-found with errors carrying a digest; those must propagate. */
const isNextSignal = (e: unknown) => typeof (e as { digest?: unknown })?.digest === 'string' && /^NEXT_(REDIRECT|HTTP_ERROR_FALLBACK|NOT_FOUND)/.test((e as { digest: string }).digest);

/**
 * A small form bound to a server action with useActionState. Shows the result
 * (or the error) under the form, and asks for confirmation first when `confirm` is set.
 */
export function ActionForm({
  action,
  submitLabel,
  pendingLabel,
  confirm,
  danger,
  className,
  children,
  testId,
  disabled,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  submitLabel: string;
  pendingLabel?: string;
  confirm?: string;
  danger?: boolean;
  className?: string;
  children?: React.ReactNode;
  testId?: string;
  disabled?: boolean;
}) {
  // A dropped connection becomes a message under the form, not the error page (which would also
  // throw away unsaved edits elsewhere on the review screen).
  const [state, formAction, pending] = useActionState(async (prev: FormState, form: FormData) => {
    try {
      return await action(prev, form);
    } catch (e) {
      if (isNextSignal(e)) throw e;
      return errorState(`The console could not be reached (${(e as Error)?.message || 'network error'}). Try again.`);
    }
  }, IDLE);
  return (
    <form
      action={formAction}
      className={className}
      data-testid={testId}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {children}
      <button type="submit" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={pending || disabled}>
        {pending ? (pendingLabel ?? 'Working…') : submitLabel}
      </button>
      <FormMessage state={state} />
    </form>
  );
}

export function FormMessage({ state }: { state: FormState }) {
  if (state.status === 'idle' || !state.message) return null;
  return (
    <p
      key={state.at}
      role={state.status === 'error' ? 'alert' : 'status'}
      className={`notice ${state.status === 'error' ? 'notice-error' : 'notice-ok'} small`}
      style={{ marginTop: 10 }}
      data-testid="form-message"
    >
      {state.message}
      {state.href ? (
        <>
          {' '}
          <Link href={state.href}>Open</Link>
        </>
      ) : null}
    </p>
  );
}
