// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const signOut = vi.fn();
  return { signOut, createServerClient: vi.fn(() => ({ auth: { signOut } })) };
});
vi.mock('@supabase/ssr', () => ({ createServerClient: mocks.createServerClient }));

import * as route from './route';
import { SIGN_OUT_TIMEOUT_MS } from '@/lib/auth/sign-out';

const SESSION_COOKIES = [
  'sb-abcd-auth-token.0=part0',
  'sb-abcd-auth-token.1=part1',
  'sb-abcd-auth-token-code-verifier=verifier',
];

function signOutRequest(cookies: string[] = [...SESSION_COOKIES, 'theme=light']) {
  return new NextRequest('http://localhost:3000/auth/sign-out', {
    method: 'POST',
    headers: { cookie: cookies.join('; ') },
  });
}

/** The cookies the response expires, by name. */
const expired = (response: Response) =>
  response.headers
    .getSetCookie()
    .filter((cookie) => /Max-Age=0/i.test(cookie) && /Path=\//i.test(cookie))
    .map((cookie) => cookie.split('=')[0]);

function expectSignedOut(response: Response) {
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe('http://localhost:3000/sign-in');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(expired(response).sort()).toEqual([
    'sb-abcd-auth-token-code-verifier',
    'sb-abcd-auth-token.0',
    'sb-abcd-auth-token.1',
  ]);
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://abcd.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
  mocks.signOut.mockResolvedValue({ error: null });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('POST /auth/sign-out (issue 224)', () => {
  it('ends this browser’s session at Supabase, clears its cookies and goes to sign in', async () => {
    const response = await route.POST(signOutRequest());
    // 'local' ends this session only; the person's other devices stay signed in.
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
    expectSignedOut(response);
    expect(expired(response)).not.toContain('theme');
  });

  it('still signs this browser out when Supabase refuses', async () => {
    mocks.signOut.mockResolvedValueOnce({ error: { status: 503, message: 'Service Unavailable' } });
    expectSignedOut(await route.POST(signOutRequest()));
  });

  it('still signs this browser out when the call to Supabase throws', async () => {
    mocks.signOut.mockRejectedValueOnce(new TypeError('fetch failed'));
    expectSignedOut(await route.POST(signOutRequest()));
  });

  it('stops waiting for a Supabase that never answers, and signs this browser out', async () => {
    vi.useFakeTimers();
    mocks.signOut.mockReturnValueOnce(new Promise(() => undefined));
    const pending = route.POST(signOutRequest());
    await vi.advanceTimersByTimeAsync(SIGN_OUT_TIMEOUT_MS);
    expectSignedOut(await pending);
  });

  it('goes to sign in without calling anything when auth is off', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    const response = await route.POST(signOutRequest(['theme=light']));
    expect(mocks.createServerClient).not.toHaveBeenCalled();
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('http://localhost:3000/sign-in');
    expect(expired(response)).toEqual([]);
  });

  it('answers POST only, so a link or an image cannot sign anyone out', () => {
    expect(Object.keys(route).filter((name) => /^[A-Z]+$/.test(name))).toEqual(['POST']);
  });
});
