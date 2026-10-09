import type { CookieOptionsWithName } from '@supabase/ssr';

/**
 * Session cookie settings. The console never runs a Supabase client in the
 * browser (every call is made on the server as the signed-in owner), so the
 * session cookie is HttpOnly: page scripts cannot read the access or refresh
 * token. It is Secure whenever the console is reached over HTTPS (directly or
 * behind a TLS-terminating proxy that sets X-Forwarded-Proto).
 */
export function sessionCookieOptions(https: boolean): CookieOptionsWithName {
  return { path: '/', sameSite: 'lax', httpOnly: true, secure: https };
}

/** True when the request reached the console over HTTPS. */
export function isHttpsRequest(forwardedProto: string | null | undefined, urlProtocol?: string): boolean {
  const first = forwardedProto?.split(',')[0]?.trim().toLowerCase();
  if (first) return first === 'https';
  return urlProtocol === 'https:';
}
