import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  requestHeaders: { value: new Headers() },
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('next/headers', () => ({ headers: async () => mocks.requestHeaders.value }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import { AuthGate } from './auth-gate';

const requestedPath = (path: string) => {
  mocks.requestHeaders.value = new Headers({ 'x-first-paycheck-path': path });
};

describe('AuthGate', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://x.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
    mocks.requestHeaders.value = new Headers();
  });

  it('renders the screen when Supabase is not configured (tests, previews)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    const children = <p>screen</p>;
    expect(await AuthGate({ children })).toBe(children);
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
  });

  it('renders the screen for a signed-in user', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce({ id: 'u1' });
    const children = <p>screen</p>;
    expect(await AuthGate({ children })).toBe(children);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('sends a signed-out visitor to sign in, remembering where they were going', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce(null);
    requestedPath('/setup/link');
    await expect(AuthGate({ children: <p>screen</p> })).rejects.toThrow(
      'NEXT_REDIRECT /sign-in?next=/setup/link',
    );
  });

  it('keeps the query string of the requested path', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce(null);
    requestedPath('/plan?tab=goals');
    await expect(AuthGate({ children: <p>screen</p> })).rejects.toThrow(
      'NEXT_REDIRECT /sign-in?next=/plan%3Ftab%3Dgoals',
    );
  });

  it('falls back to plain /sign-in without a usable path', async () => {
    for (const path of [null, '//evil.example']) {
      mocks.getCurrentUser.mockResolvedValueOnce(null);
      if (path) requestedPath(path);
      await expect(AuthGate({ children: <p>screen</p> })).rejects.toThrow(
        /^NEXT_REDIRECT \/sign-in$/,
      );
    }
  });
});
