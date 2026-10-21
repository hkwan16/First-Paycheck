// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type CookieOptions = {
  getAll: () => { name: string; value: string }[];
  setAll: (c: { name: string; value: string; options?: object }[], headers?: object) => void;
};

const mocks = vi.hoisted(() => {
  const getClaims = vi.fn();
  const createServerClient = vi.fn(
    (_url: string, _key: string, _options: { cookies: CookieOptions }) => ({
      auth: { getClaims },
    }),
  );
  return { getClaims, createServerClient };
});
vi.mock('@supabase/ssr', () => ({ createServerClient: mocks.createServerClient }));

import { updateSession } from './proxy';

const request = () =>
  new NextRequest('http://localhost:3000/setup/link', {
    headers: { cookie: 'sb-access=old' },
  });

/** Simulate supabase-js refreshing an expired token during getClaims(). */
function refreshDuringGetClaims() {
  mocks.getClaims.mockImplementationOnce(async () => {
    const options = mocks.createServerClient.mock.calls.at(-1)?.[2];
    expect(options?.cookies.getAll()).toEqual([{ name: 'sb-access', value: 'old' }]);
    options?.cookies.setAll([{ name: 'sb-access', value: 'new', options: { path: '/' } }], {
      'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0',
    });
    return { data: { claims: { sub: 'u1' } }, error: null };
  });
}

describe('updateSession', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://x.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    mocks.getClaims.mockResolvedValue({ data: null, error: null });
  });

  it('passes the request through untouched without Supabase env vars', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    const response = await updateSession(request());
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(mocks.createServerClient).not.toHaveBeenCalled();
  });

  it('refreshes the session by calling getClaims, the @supabase/ssr proxy pattern', async () => {
    await updateSession(request());
    expect(mocks.getClaims).toHaveBeenCalledOnce();
  });

  it('reads request cookies and writes refreshed ones to the request and the response', async () => {
    refreshDuringGetClaims();
    const response = await updateSession(request());
    expect(response.cookies.get('sb-access')?.value).toBe('new');
    expect(response.headers.get('cache-control')).toContain('no-store');
    // Server Components in this same request see the refreshed cookie.
    expect(response.headers.get('x-middleware-request-cookie')).toBe('sb-access=new');
  });

  it('forwards extra request headers, with or without Supabase', async () => {
    const extra = { 'x-first-paycheck-path': '/setup/link' };
    refreshDuringGetClaims();
    const refreshed = await updateSession(request(), extra);
    expect(refreshed.headers.get('x-middleware-request-x-first-paycheck-path')).toBe('/setup/link');

    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    const passthrough = await updateSession(request(), extra);
    expect(passthrough.headers.get('x-middleware-request-x-first-paycheck-path')).toBe(
      '/setup/link',
    );
  });
});
