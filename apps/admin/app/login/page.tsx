import type { Metadata } from 'next';
import { safeNextPath } from '@/lib/roles';
import { LoginForm } from './LoginForm';

export const metadata: Metadata = { title: 'Sign in · Review console' };

const NOTICES: Record<string, string> = {
  not_authorized: 'Not authorized. This console is for the owner’s admin account only; you have been signed out.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : null;
  return (
    <main className="login">
      <div className="login-card">
        <p className="kicker">Social Issues · Review console</p>
        <h1>Sign in</h1>
        <p className="muted">Only the owner’s admin account can review and publish cases.</p>
        <LoginForm next={safeNextPath(sp.next)} notice={error ? (NOTICES[error] ?? null) : null} />
      </div>
    </main>
  );
}
