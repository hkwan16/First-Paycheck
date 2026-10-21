import { describe, expect, it, vi } from 'vitest';
import { readSupabaseEnv } from './env';

describe('readSupabaseEnv', () => {
  it('returns null when either variable is missing, so tests and previews run without Supabase', () => {
    expect(readSupabaseEnv({})).toBeNull();
    expect(readSupabaseEnv({ NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co' })).toBeNull();
    expect(
      readSupabaseEnv({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' }),
    ).toBeNull();
    expect(
      readSupabaseEnv({
        NEXT_PUBLIC_SUPABASE_URL: ' ',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
      }),
    ).toBeNull();
  });

  it('returns the url and publishable key when both are set', () => {
    expect(
      readSupabaseEnv({
        NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
      }),
    ).toEqual({ url: 'https://x.supabase.co', publishableKey: 'sb_publishable_test' });
  });

  it('reads process.env by default', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://y.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'key');
    expect(readSupabaseEnv()).toEqual({ url: 'https://y.supabase.co', publishableKey: 'key' });
  });
});
