/**
 * Public Supabase settings for the admin console. The console signs the owner
 * in with the anon (publishable) key and acts as that user, so row-level
 * security and the database's review actions decide everything. A service-role
 * key would bypass all of that, so it is refused outright.
 */

export interface SupabaseEnv {
  url: string;
  anonKey: string;
}

function base64UrlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return typeof atob === 'function' ? atob(padded) : Buffer.from(padded, 'base64').toString('binary');
}

/** The `role` claim of a legacy JWT API key, or null when the key is not a JWT. */
export function jwtRole(key: string): string | null {
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1]!)) as { role?: unknown };
    return typeof payload.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}

/** True for any key that would bypass row-level security. */
export function isPrivilegedKey(key: string): boolean {
  if (key.startsWith('sb_secret_')) return true;
  const role = jwtRole(key);
  return role !== null && role !== 'anon';
}

export function readSupabaseEnv(
  env: Record<string, string | undefined> = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  },
): SupabaseEnv {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) {
    throw new Error('Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (see apps/admin/.env.example).');
  }
  if (isPrivilegedKey(anonKey)) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_ANON_KEY is a service-role (secret) key. The admin console must use the anon key and act as the signed-in owner.',
    );
  }
  return { url, anonKey };
}

/** Base URL of the public dive app, for transparency-page links. Optional. */
export function diveAppUrl(): string | null {
  const v = process.env.NEXT_PUBLIC_DIVE_APP_URL?.trim();
  return v ? v.replace(/\/+$/, '') : null;
}
