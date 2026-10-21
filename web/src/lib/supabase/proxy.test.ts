// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type CookieOptions = {
  getAll: () => { name: string; value: string }[];
  setAll: (c: { name: string; value: string; options?: object }[], headers?: object) => void;
};

const mocks = vi.hoisted(() => {
  const getUser = vi.fn();
  const createServerClient = vi.fn(
    (_url: string, _key: string, _options: { cookies: CookieOptions }) => ({ auth: { getUser } }),
  );
  return { getUser, createServerClient };
});
vi.mock('@supabase/ssr', () => ({ createServerClient: mocks.createServerClient }));

import { updateSession } from './proxy';

const request = () =>
  new NextRequest('http://localhost:3000/setup/link', {
    headers: { cookie: 'sb-access=old' },
  });

describe('updateSession', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://x.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
  });

  it('passes the request through untouched without Supabase env vars', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    const response = await updateSession(request());
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(mocks.createServerClient).not.toHaveBeenCalled();
  });

  it('refreshes the session by calling getUser', async () => {
    await updateSession(request());
    expect(mocks.getUser).toHaveBeenCalledOnce();
  });

  it('reads request cookies and writes refreshed ones to the request and the response', async () => {
    mocks.getUser.mockImplementationOnce(async () => {
      const options = mocks.createServerClient.mock.calls.at(-1)?.[2];
      expect(options?.cookies.getAll()).toEqual([{ name: 'sb-access', value: 'old' }]);
      options?.cookies.setAll([{ name: 'sb-access', value: 'new', options: { path: '/' } }], {
        'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0',
      });
      return { data: { user: { id: 'u1' } }, error: null };
    });
    const response = await updateSession(request());
    expect(response.cookies.get('sb-access')?.value).toBe('new');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
});
