import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_TIMEOUT_MS } from '@/lib/auth/timeout';
import { encodeVerifiedUser, VERIFIED_USER_HEADER } from '@/lib/auth/verified-user';

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
  const requestHeaders = new Headers();
  return {
    store,
    getUser,
    createServerClient,
    requestHeaders,
    cookies: vi.fn(async () => store),
    headers: vi.fn(async () => requestHeaders),
    connection: vi.fn(async () => undefined),
  };
});

vi.mock('next/headers', () => ({ cookies: mocks.cookies, headers: mocks.headers }));
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
  afterEach(() => {
    vi.useRealTimers();
    mocks.requestHeaders.delete(VERIFIED_USER_HEADER);
  });

  it('returns the verified user', async () => {
    mocks.getUser.mockResolvedValueOnce({ data: { user: { id: 'u1' } }, error: null });
    expect(await getCurrentUser()).toEqual({ id: 'u1' });
  });

  it('returns null when the session is missing or invalid', async () => {
    mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: new Error('no session') });
    expect(await getCurrentUser()).toBeNull();
  });

  it('renders for the user the proxy verified when getUser() does not answer in time (issue 288)', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const alex = { id: 'u1', email: 'alex@example.com', user_metadata: { name: 'Alex' } };
    mocks.requestHeaders.set(VERIFIED_USER_HEADER, encodeVerifiedUser(alex));
    mocks.getUser.mockReturnValueOnce(new Promise(() => undefined));
    const pending = getCurrentUser();
    await vi.advanceTimersByTimeAsync(AUTH_TIMEOUT_MS - 1);
    expect(mocks.headers).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual(alex);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('did not answer');
  });

  it('is signed out when getUser() does not answer and the proxy verified no one', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.getUser.mockReturnValueOnce(new Promise(() => undefined));
    const pending = getCurrentUser();
    await vi.advanceTimersByTimeAsync(AUTH_TIMEOUT_MS);
    expect(await pending).toBeNull();
  });

  it('never trusts a verified-user header while getUser() answers', async () => {
    mocks.requestHeaders.set(
      VERIFIED_USER_HEADER,
      encodeVerifiedUser({ id: 'u2', user_metadata: {} }),
    );
    mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: new Error('revoked') });
    expect(await getCurrentUser()).toBeNull();
    expect(mocks.headers).not.toHaveBeenCalled();
  });
});
