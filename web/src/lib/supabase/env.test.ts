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

  it('treats a malformed url as not configured and warns, instead of crashing every request', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const url of ['wzfz.supabase.co', '"https://x.supabase.co"', 'https://', 'not a url']) {
      expect(
        readSupabaseEnv({
          NEXT_PUBLIC_SUPABASE_URL: url,
          NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
        }),
      ).toBeNull();
    }
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn.mock.calls[0]?.[0]).toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
    warn.mockRestore();
  });

  it('accepts http and https urls only', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      readSupabaseEnv({
        NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'k',
      }),
    ).toEqual({ url: 'http://127.0.0.1:54321', publishableKey: 'k' });
    expect(
      readSupabaseEnv({
        NEXT_PUBLIC_SUPABASE_URL: 'ftp://x.supabase.co',
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'k',
      }),
    ).toBeNull();
    warn.mockRestore();
  });

  it('reads process.env by default', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://y.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'key');
    expect(readSupabaseEnv()).toEqual({ url: 'https://y.supabase.co', publishableKey: 'key' });
  });
});
