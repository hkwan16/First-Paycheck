import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { isAuthCookie, SIGN_OUT_TIMEOUT_MS } from '@/lib/auth/sign-out';
import { signInRoute } from '@/lib/routes';
import { readSupabaseEnv } from '@/lib/supabase/env';
import { withTimeout } from '@/lib/timeout';

/**
 * Sign out of this browser (issue 224): the account menu's Sign out is a form
 * that posts here, so it is a full navigation that leaves no state of the
 * session in the page.
 *
 * It asks Supabase to end this session (`scope: 'local'`, so the person's
 * other devices stay signed in), then expires every Supabase cookie the
 * request carries whatever Supabase answered: a refusal, a thrown fetch or no
 * answer within `SIGN_OUT_TIMEOUT_MS` still signs this browser out. The
 * proxy leaves this path alone, so no refreshed session cookie races the
 * expiry. POST only: a link or an image cannot sign anyone out.
 */
export async function POST(request: NextRequest) {
  const response = NextResponse.redirect(new URL(signInRoute(), request.url), 303);
  response.headers.set('Cache-Control', 'no-store');

  const env = readSupabaseEnv();
  if (!env) return response;

  const supabase = createServerClient(env.url, env.publishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      // Nothing Supabase writes is kept: the response expires every session cookie below.
      setAll: () => undefined,
    },
  });
  try {
    await withTimeout(supabase.auth.signOut({ scope: 'local' }), SIGN_OUT_TIMEOUT_MS);
  } catch {
    // Unreachable, failing or silent Auth: this browser signs out all the same.
  }

  for (const { name } of request.cookies.getAll()) {
    if (isAuthCookie(name)) response.cookies.set(name, '', { path: '/', maxAge: 0 });
  }
  return response;
}
