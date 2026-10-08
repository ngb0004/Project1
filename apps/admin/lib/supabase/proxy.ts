import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { readSupabaseEnv } from '../env';
import { isAdminUser } from '../roles';

/** Paths that work without a session. */
export const PUBLIC_PATHS = ['/login'];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Refreshes the Supabase session cookies on every request and keeps signed-out
 * visitors on /login. A signed-in account that is not the admin is signed out
 * here (the proxy can write cookies; pages cannot) and sent to /login with a
 * "not authorized" message.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const { url, anonKey } = readSupabaseEnv();
  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        for (const [key, value] of Object.entries(headers ?? {})) response.headers.set(key, value);
      },
    },
  });

  // getUser() asks the auth server, so a revoked session or a stale role is caught here.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { pathname, search } = request.nextUrl;

  const redirectTo = (target: URL) => {
    const r = NextResponse.redirect(target);
    // Carry refreshed (or cleared) auth cookies over to the redirect.
    for (const c of response.cookies.getAll()) r.cookies.set(c);
    return r;
  };

  if (user && !isAdminUser(user)) {
    await supabase.auth.signOut({ scope: 'local' });
    const target = new URL('/login', request.url);
    target.searchParams.set('error', 'not_authorized');
    return redirectTo(target);
  }

  if (!user && !isPublicPath(pathname)) {
    const target = new URL('/login', request.url);
    if (pathname !== '/') target.searchParams.set('next', `${pathname}${search}`);
    return redirectTo(target);
  }

  return response;
}
