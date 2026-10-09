import { describe, expect, it } from 'vitest';
import { isPrivilegedKey, jwtRole, readSupabaseEnv } from '@/lib/env';
import { isAdminUser, safeNextPath } from '@/lib/roles';
import { isPublicPath } from '@/lib/supabase/proxy';

// Public local demo keys (every `supabase start` stack ships these).
const ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

describe('admin role', () => {
  it('admits only app_metadata.app_role = admin', () => {
    expect(isAdminUser({ app_metadata: { app_role: 'admin' } })).toBe(true);
    expect(isAdminUser({ app_metadata: { app_role: 'pipeline' } })).toBe(false);
    expect(isAdminUser({ app_metadata: {} })).toBe(false);
    expect(isAdminUser(null)).toBe(false);
    // user_metadata is writable by the user, so it never counts.
    expect(isAdminUser({ app_metadata: {}, user_metadata: { app_role: 'admin' } } as never)).toBe(false);
  });

  it('keeps post-login redirects on this site', () => {
    expect(safeNextPath('/review/a/1')).toBe('/review/a/1');
    expect(safeNextPath('https://evil.example')).toBe('/');
    expect(safeNextPath('//evil.example')).toBe('/');
    expect(safeNextPath('/\\evil.example')).toBe('/');
    expect(safeNextPath('/login')).toBe('/');
    expect(safeNextPath(undefined)).toBe('/');
    expect(safeNextPath('/review/a/1?tab=diff#actions')).toBe('/review/a/1?tab=diff#actions');
  });

  it('refuses paths a browser would turn into another site', () => {
    // Browsers strip TAB/CR/LF from URLs, so these become "//evil.example".
    expect(safeNextPath('/\t/evil.example')).toBe('/');
    expect(safeNextPath('/\n/evil.example')).toBe('/');
    expect(safeNextPath('/\r/evil.example')).toBe('/');
    expect(safeNextPath('/ /evil.example')).toBe('/');
    expect(safeNextPath('/\u0000/evil.example')).toBe('/');
    expect(safeNextPath('\\/evil.example')).toBe('/');
    expect(safeNextPath('/\\/evil.example')).toBe('/');
    // Dot segments normalize to a protocol-relative path.
    expect(safeNextPath('/.//evil.example')).toBe('/');
    expect(safeNextPath('/a/..//evil.example')).toBe('/');
    expect(safeNextPath('/%2e//evil.example')).toBe('/');
    expect(safeNextPath('/./login')).toBe('/');
    // Encoded characters stay encoded (a path, never a host).
    expect(safeNextPath('/%09/evil.example')).toBe('/%09/evil.example');
    for (const bad of ['/\t/evil.example', '/.//evil.example', '/%2e//evil.example']) {
      const resolved = new URL(safeNextPath(bad), 'https://console.example');
      expect(resolved.origin).toBe('https://console.example');
    }
  });

  it('only /login is public', () => {
    expect(isPublicPath('/login')).toBe(true);
    expect(isPublicPath('/')).toBe(false);
    expect(isPublicPath('/loginx')).toBe(false);
    expect(isPublicPath('/review/x/1')).toBe(false);
  });
});

describe('Supabase env', () => {
  it('reads the role of a JWT key', () => {
    expect(jwtRole(ANON)).toBe('anon');
    expect(jwtRole(SERVICE)).toBe('service_role');
    expect(jwtRole('sb_publishable_abc')).toBeNull();
  });

  it('refuses service-role and secret keys', () => {
    expect(isPrivilegedKey(SERVICE)).toBe(true);
    expect(isPrivilegedKey('sb_secret_abc')).toBe(true);
    expect(isPrivilegedKey(ANON)).toBe(false);
    expect(isPrivilegedKey('sb_publishable_abc')).toBe(false);
    expect(() => readSupabaseEnv({ NEXT_PUBLIC_SUPABASE_URL: 'http://x', NEXT_PUBLIC_SUPABASE_ANON_KEY: SERVICE })).toThrow(/service-role/);
    expect(() => readSupabaseEnv({ NEXT_PUBLIC_SUPABASE_URL: '', NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON })).toThrow(/Set NEXT_PUBLIC/);
    expect(readSupabaseEnv({ NEXT_PUBLIC_SUPABASE_URL: 'http://x', NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON })).toEqual({ url: 'http://x', anonKey: ANON });
  });
});
