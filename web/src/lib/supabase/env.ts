export interface SupabaseEnv {
  url: string;
  anonKey: string;
}

type Env = Partial<Record<'NEXT_PUBLIC_SUPABASE_URL' | 'NEXT_PUBLIC_SUPABASE_ANON_KEY', string>>;

/**
 * Supabase settings, or null when they are not configured (unit tests,
 * Playwright smoke runs, previews without secrets). Every caller treats null
 * as "auth is off" instead of crashing.
 */
export function readSupabaseEnv(
  env: Env = {
    // Spelled out so Next inlines them into the browser bundle.
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  },
): SupabaseEnv | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  return url && anonKey ? { url, anonKey } : null;
}
