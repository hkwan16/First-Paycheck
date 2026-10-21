import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import { AuthGate } from './auth-gate';

describe('AuthGate', () => {
  beforeEach(() => {
    mocks.getCurrentUser.mockReset();
    mocks.redirect.mockClear();
  });

  it('renders the screen when Supabase is not configured (tests, previews)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    const children = <p>screen</p>;
    expect(await AuthGate({ children })).toBe(children);
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
  });

  it('renders the screen for a signed-in user', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://x.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
    mocks.getCurrentUser.mockResolvedValueOnce({ id: 'u1' });
    const children = <p>screen</p>;
    expect(await AuthGate({ children })).toBe(children);
  });

  it('sends a signed-out visitor to sign in', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://x.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
    mocks.getCurrentUser.mockResolvedValueOnce(null);
    await expect(AuthGate({ children: <p>screen</p> })).rejects.toThrow('NEXT_REDIRECT /sign-in');
  });
});
