import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { readSupabaseEnv } from './env';

/**
 * Refresh the Supabase session cookie on every request so Server Components
 * see a valid token, and forward `extraHeaders` to the app. Without Supabase
 * env vars it only forwards the headers.
 */
export async function updateSession(
  request: NextRequest,
  extraHeaders: Record<string, string> = {},
): Promise<NextResponse> {
  // Built from the request each time, so cookies written by setAll below
  // reach the Server Components rendering this same request.
  const next = () => {
    const headers = new Headers(request.headers);
    for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
    return NextResponse.next({ request: { headers } });
  };

  let response = next();
  const env = readSupabaseEnv();
  if (!env) return response;

  const supabase = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet, headers) => {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = next();
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        // No-store headers keep a CDN from caching a response that sets a session cookie.
        for (const [key, value] of Object.entries(headers ?? {})) {
          response.headers.set(key, value);
        }
      },
    },
  });

  // Do not run code between creating the client and getClaims(): it is what
  // refreshes an expired token (triggering setAll above). It verifies the JWT
  // against the project's signing keys, so it needs no Auth round trip.
  await supabase.auth.getClaims();
  return response;
}
