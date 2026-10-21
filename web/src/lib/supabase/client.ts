import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readSupabaseEnv } from './env';

let client: SupabaseClient | undefined;

/** The browser Supabase client (a singleton), or null when Supabase is not configured. */
export function getSupabaseBrowserClient(): SupabaseClient | null {
  if (client) return client;
  const env = readSupabaseEnv();
  if (!env) return null;
  client = createBrowserClient(env.url, env.publishableKey);
  return client;
}
