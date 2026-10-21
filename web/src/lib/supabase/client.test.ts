import { beforeEach, describe, expect, it, vi } from 'vitest';

const createBrowserClient = vi.hoisted(() => vi.fn(() => ({ auth: {} })));
vi.mock('@supabase/ssr', () => ({ createBrowserClient }));

describe('getSupabaseBrowserClient', () => {
  beforeEach(() => {
    vi.resetModules();
    createBrowserClient.mockClear();
  });

  it('returns null without Supabase env vars', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', '');
    const { getSupabaseBrowserClient } = await import('./client');
    expect(getSupabaseBrowserClient()).toBeNull();
    expect(createBrowserClient).not.toHaveBeenCalled();
  });

  it('creates one browser client and reuses it', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://x.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    const { getSupabaseBrowserClient } = await import('./client');
    const first = getSupabaseBrowserClient();
    expect(first).not.toBeNull();
    expect(getSupabaseBrowserClient()).toBe(first);
    expect(createBrowserClient).toHaveBeenCalledExactlyOnceWith(
      'https://x.supabase.co',
      'sb_publishable_test',
    );
  });
});
