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

/** Keeps post-login redirects on this site: only local absolute paths are allowed. */
export function safeNextPath(next: unknown): string {
  if (typeof next !== 'string') return '/';
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  if (next.startsWith('/login')) return '/';
  return next;
}
