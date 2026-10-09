import Link from 'next/link';
import { requireAdmin } from '@/lib/auth';
import { signOut } from '../login/actions';

/** Every console page sits behind requireAdmin (the proxy is not the only gate). */
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const { email } = await requireAdmin();
  return (
    <>
      <header className="topbar">
        <Link href="/" className="brand">
          Review console
        </Link>
        <nav aria-label="Console">
          <Link href="/">Queue</Link>
          <Link href="/#cases">Cases</Link>
          <Link href="/#jobs">Pipeline</Link>
        </nav>
        <span className="who" data-testid="signed-in-as">
          {email}
        </span>
        <form action={signOut}>
          <button type="submit" className="btn btn-small">
            Sign out
          </button>
        </form>
      </header>
      {children}
    </>
  );
}
