export interface SupabaseEnv {
  url: string;
  publishableKey: string;
}

type Env = Partial<
  Record<'NEXT_PUBLIC_SUPABASE_URL' | 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', string>
>;

/**
 * Supabase settings, or null when they are not configured (unit tests,
 * Playwright smoke runs, previews without secrets). Every caller treats null
 * as "auth is off" instead of crashing.
 */
export function readSupabaseEnv(
  env: Env = {
    // Spelled out so Next inlines them into the browser bundle.
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  },
): SupabaseEnv | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !publishableKey) return null;
  if (!isHttpUrl(url)) {
    // A bad value must not take every route down: the proxy and the guard run
    // on each request, so a thrown error here is a site-wide 500.
    console.warn(
      `NEXT_PUBLIC_SUPABASE_URL is not a valid http(s) URL; running with auth off. Got: ${JSON.stringify(url)}`,
    );
    return null;
  }
  return { url, publishableKey };
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname !== '';
  } catch {
    return false;
  }
}
