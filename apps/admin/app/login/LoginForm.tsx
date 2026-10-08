'use client';

import { useActionState } from 'react';
import { signIn, type LoginState } from './actions';

export function LoginForm({ next, notice }: { next: string; notice: string | null }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(signIn, { error: null, email: '' });
  const message = state.error ?? notice;
  return (
    <form action={action} className="login-form" aria-describedby={message ? 'login-message' : undefined}>
      <input type="hidden" name="next" value={next} />
      <label className="field">
        <span className="field-label">Email</span>
        <input name="email" type="email" autoComplete="username" required defaultValue={state.email} />
      </label>
      <label className="field">
        <span className="field-label">Password</span>
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      {message ? (
        <p id="login-message" role="alert" className="notice notice-error" data-testid="login-message">
          {message}
        </p>
      ) : null}
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
