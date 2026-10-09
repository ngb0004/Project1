/** The only role allowed into the console. v1 has one admin: the owner. */
export const ADMIN_ROLE = 'admin';

export interface UserLike {
  app_metadata?: Record<string, unknown> | null;
}

/**
 * Only app_metadata counts: it is writable by the service role alone, while
 * user_metadata can be changed by the user themselves.
 */
export function isAdminUser(user: UserLike | null | undefined): boolean {
  return user?.app_metadata?.app_role === ADMIN_ROLE;
}

const DUMMY_ORIGIN = 'http://console.invalid';

/**
 * Keeps post-login redirects on this site: only local absolute paths are
 * allowed. Browsers strip tabs and newlines from URLs and treat "\\" like "/",
 * so "/\t/evil.example" would become "//evil.example"; any control character or
 * backslash is refused outright, and the path must resolve to this origin.
 */
export function safeNextPath(next: unknown): string {
  if (typeof next !== 'string' || !next.startsWith('/') || next.length > 2048) return '/';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f\\]/.test(next)) return '/';
  let u: URL;
  try {
    u = new URL(next, DUMMY_ORIGIN);
  } catch {
    return '/';
  }
  // Dot segments can normalize "/.//host" to "//host", which a browser reads as another site.
  if (u.origin !== DUMMY_ORIGIN || u.pathname.startsWith('//')) return '/';
  if (u.pathname === '/login' || u.pathname.startsWith('/login/')) return '/';
  return `${u.pathname}${u.search}${u.hash}`;
}
