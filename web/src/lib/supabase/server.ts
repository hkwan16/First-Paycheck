import 'server-only';
import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { connection } from 'next/server';
import { cache } from 'react';
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
 */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getUser();
  return error ? null : data.user;
});
