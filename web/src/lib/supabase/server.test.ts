import { beforeEach, describe, expect, it, vi } from 'vitest';

type CookieOptions = { getAll: () => unknown; setAll: (c: unknown[]) => void };

const mocks = vi.hoisted(() => {
  const store = {
    getAll: vi.fn(() => [{ name: 'sb-access', value: 'token' }]),
    set: vi.fn(),
  };
  const getUser = vi.fn();
  const createServerClient = vi.fn(
    (_url: string, _key: string, _options: { cookies: CookieOptions }) => ({ auth: { getUser } }),
  );
  return {
    store,
    getUser,
    createServerClient,
    cookies: vi.fn(async () => store),
    connection: vi.fn(async () => undefined),
  };
});

vi.mock('next/headers', () => ({ cookies: mocks.cookies }));
vi.mock('next/server', () => ({ connection: mocks.connection }));
vi.mock('@supabase/ssr', () => ({ createServerClient: mocks.createServerClient }));

import { getCurrentUser, getSupabaseServerClient } from './server';

describe('getSupabaseServerClient', () => {
  beforeEach(() => {
    mocks.cookies.mockClear();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://x.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
  });

  it('returns null without env vars and never touches cookies', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    expect(await getSupabaseServerClient()).toBeNull();
    expect(mocks.cookies).not.toHaveBeenCalled();
  });

  it('waits for the request before building a client, because supabase-js reads the clock', async () => {
    // auth-js compares the session's expiry with Date.now(). Read during a
    // prerender (dev validates each route's instant UI with the request's
    // cookies), that is an unstable value Next reports as an error.
    mocks.connection.mockClear();
    mocks.createServerClient.mockClear();
    await getSupabaseServerClient();
    expect(mocks.connection).toHaveBeenCalledOnce();
    expect(mocks.connection.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createServerClient.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('wires the request cookies through getAll and setAll', async () => {
    await getSupabaseServerClient();
    const options = mocks.createServerClient.mock.calls.at(-1)?.[2];
    expect(options?.cookies.getAll()).toEqual([{ name: 'sb-access', value: 'token' }]);
    options?.cookies.setAll([{ name: 'sb-access', value: 'new', options: { path: '/' } }]);
    expect(mocks.store.set).toHaveBeenCalledWith('sb-access', 'new', { path: '/' });
  });

  it('swallows the write error a Server Component raises (the proxy refreshes instead)', async () => {
    mocks.store.set.mockImplementationOnce(() => {
      throw new Error('Cookies can only be modified in a Server Action or Route Handler');
    });
    await getSupabaseServerClient();
    const options = mocks.createServerClient.mock.calls.at(-1)?.[2];
    expect(() => options?.cookies.setAll([{ name: 'a', value: 'b', options: {} }])).not.toThrow();
  });
});

describe('getCurrentUser', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://x.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
  });

  it('returns the verified user', async () => {
    mocks.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } }, error: null });
    expect(await getCurrentUser()).toEqual({ id: 'u1' });
  });

  it('returns null when the session is missing or invalid', async () => {
    mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: new Error('no session') });
    expect(await getCurrentUser()).toBeNull();
  });
});
