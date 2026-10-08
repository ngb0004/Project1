import { cache } from 'react';
import { redirect } from 'next/navigation';
import type { Db } from '@sia/case-store';
import { isAdminUser } from './roles';
import { createSupabaseServerClient } from './supabase/server';

export interface AdminSession {
  db: Db;
  userId: string;
  email: string;
}

export const NOT_AUTHORIZED_PATH = '/login?error=not_authorized';

/**
 * The signed-in admin, or a redirect. Every page and every server action calls
 * this itself (the proxy is not the only gate): no session goes to /login, and
 * any other account is signed out and told it is not authorized.
 */
export const requireAdmin = cache(async (): Promise<AdminSession> => {
  const db = await createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect('/login');
  if (!isAdminUser(user)) {
    // In a Server Component the cookie write is skipped, but the session is
    // revoked on the auth server and the proxy clears the cookies next request.
    await db.auth.signOut({ scope: 'local' }).catch(() => undefined);
    redirect(NOT_AUTHORIZED_PATH);
  }
  return { db, userId: user.id, email: user.email ?? user.id };
});
