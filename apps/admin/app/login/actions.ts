'use server';

import { redirect } from 'next/navigation';
import { isAdminUser, safeNextPath } from '@/lib/roles';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export interface LoginState {
  error: string | null;
  email: string;
}

export async function signIn(_prev: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get('email') ?? '').trim();
  const password = String(form.get('password') ?? '');
  if (!email || !password) return { error: 'Enter your email and password.', email };

  const db = await createSupabaseServerClient();
  const { data, error } = await db.auth.signInWithPassword({ email, password });
  if (error || !data.user) return { error: 'Sign-in failed. Check the email and password.', email };

  if (!isAdminUser(data.user)) {
    await db.auth.signOut({ scope: 'local' });
    return { error: 'Not authorized. This console is for the owner’s admin account only; you have been signed out.', email };
  }
  redirect(safeNextPath(form.get('next')));
}

export async function signOut(): Promise<void> {
  const db = await createSupabaseServerClient();
  await db.auth.signOut({ scope: 'local' });
  redirect('/login');
}
