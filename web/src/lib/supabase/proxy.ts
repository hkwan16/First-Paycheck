import { createServerClient, type SetAllCookies } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { readSupabaseEnv } from './env';

export type ProxySession = {
  /** Continues to the app, with refreshed cookies and the extra request headers. */
  response: NextResponse;
  /** Whether the request carries a verified session; null when auth is off (no Supabase env). */
  signedIn: boolean | null;
  /** A redirect to `url` that still sets the cookies and headers the refresh wrote. */
  redirectTo: (url: URL) => NextResponse;
};

/**
 * Refresh the Supabase session cookie on every request so Server Components
 * see a valid token, forward `extraHeaders` to the app, and report whether the
 * request is signed in. Without Supabase env vars it only forwards the headers.
 */
export async function updateSession(
  request: NextRequest,
  extraHeaders: Record<string, string> = {},
): Promise<ProxySession> {
  // Built from the request each time, so cookies written by setAll below
  // reach the Server Components rendering this same request.
  const next = () => {
    const headers = new Headers(request.headers);
    for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
    return NextResponse.next({ request: { headers } });
  };

  // Everything setAll has written. supabase-js may write more than once and
  // sends the no-store headers only with the first write, so the writes are
  // merged and replayed onto whichever response leaves the proxy.
  const cookies = new Map<string, Parameters<SetAllCookies>[0][number]>();
  const cacheHeaders: Record<string, string> = {};
  const withSession = (response: NextResponse) => {
    for (const { name, value, options } of cookies.values()) {
      response.cookies.set(name, value, options);
    }
    // No-store headers keep a CDN from caching a response that sets a session cookie.
    for (const [key, value] of Object.entries(cacheHeaders)) response.headers.set(key, value);
    return response;
  };

  let response = next();
  const redirectTo = (url: URL) => withSession(NextResponse.redirect(url));

  const env = readSupabaseEnv();
  if (!env) return { response, signedIn: null, redirectTo };

  const setAll: SetAllCookies = (cookiesToSet, headers) => {
    for (const cookie of cookiesToSet) {
      cookies.set(cookie.name, cookie);
      request.cookies.set(cookie.name, cookie.value);
    }
    Object.assign(cacheHeaders, headers);
    response = withSession(next());
  };
  const supabase = createServerClient(env.url, env.publishableKey, {
    cookies: { getAll: () => request.cookies.getAll(), setAll },
  });

  // Do not run code between creating the client and getClaims(): it is what
  // refreshes an expired token (triggering setAll above). It verifies the JWT
  // against the project's signing keys, so it needs no Auth round trip.
  const { data } = await supabase.auth.getClaims();
  return { response, signedIn: Boolean(data?.claims), redirectTo };
}
