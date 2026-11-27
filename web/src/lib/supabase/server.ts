import 'server-only';
import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies, headers } from 'next/headers';
import { connection } from 'next/server';
import { cache } from 'react';
import { AUTH_TIMEOUT_MS, withAuthTimeout } from '@/lib/auth/timeout';
import {
  type CurrentUser,
  parseVerifiedUser,
  VERIFIED_USER_HEADER,
} from '@/lib/auth/verified-user';
import { readSupabaseEnv } from './env';

/**
 * A Supabase client bound to this request's cookies, or null when Supabase is
 * not configured. Create one per request; never share it.
 *
 * It renders at request time only (`connection()`): supabase-js compares the
 * session's expiry with `Date.now()`, which Cache Components rejects while
 * prerendering (dev validates each route's instant UI with the request's
 * cookies, so cookies() alone does not keep it out of the prerender).
 */
export async function getSupabaseServerClient(): Promise<SupabaseClient | null> {
  const env = readSupabaseEnv();
  if (!env) return null;
  await connection();
  const cookieStore = await cookies();
  return createServerClient(env.url, env.publishableKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot write cookies. The proxy (src/proxy.ts)
          // refreshes the session on every request, so this write is redundant.
        }
      },
    },
  });
}

/**
 * The signed-in user, verified with Supabase Auth (`getUser()` asks the Auth
 * server, so a revoked session is caught), or null. `cache` makes the guard,
 * the header and any page in one server render share a single round trip.
 *
 * When Auth does not answer within `AUTH_TIMEOUT_MS` (issue 288), nothing says
 * the session was revoked, and the proxy has already verified this request's
 * JWT: the screen renders for the user that JWT names (`VERIFIED_USER_HEADER`)
 * rather than bouncing to sign-in, and the request logs one warning. The API
 * still verifies the token on every call, so no data shows on the proxy's word
 * alone.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return null;
  try {
    const { data, error } = await withAuthTimeout(supabase.auth.getUser());
    return error ? null : data.user;
  } catch (error) {
    const verified = parseVerifiedUser((await headers()).get(VERIFIED_USER_HEADER));
    console.warn(
      `getUser() did not answer within ${AUTH_TIMEOUT_MS} ms; ${
        verified
          ? 'rendering for the user the proxy verified'
          : 'the proxy verified no one, so signed out'
      }`,
      error,
    );
    return verified;
  }
});
