import { createServerClient } from '@supabase/ssr';
import { cookies, headers } from 'next/headers';
import type { Db } from '@sia/case-store';
import { readSupabaseEnv } from '../env';
import { isHttpsRequest, sessionCookieOptions } from './cookie-options';

/**
 * A Supabase client for this request, acting as the signed-in user (the owner).
 * Create one per request; never share it.
 */
export async function createSupabaseServerClient(): Promise<Db> {
  const { url, anonKey } = readSupabaseEnv();
  const cookieStore = await cookies();
  const https = isHttpsRequest((await headers()).get('x-forwarded-proto'));
  return createServerClient(url, anonKey, {
    cookieOptions: sessionCookieOptions(https),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Server Components cannot set cookies; proxy.ts refreshes the session instead.
        }
      },
    },
  }) as unknown as Db;
}
