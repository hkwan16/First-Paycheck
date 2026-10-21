// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const exchangeCodeForSession = vi.fn();
  return {
    exchangeCodeForSession,
    getSupabaseServerClient: vi.fn(async () => ({ auth: { exchangeCodeForSession } })),
  };
});
vi.mock('@/lib/supabase/server', () => ({
  getSupabaseServerClient: mocks.getSupabaseServerClient,
}));

import { GET } from './route';

const callback = (query: string) =>
  GET(new NextRequest(`http://localhost:3000/auth/callback${query}`));

const location = (response: Response) => response.headers.get('location');

describe('GET /auth/callback', () => {
  beforeEach(() => {
    mocks.exchangeCodeForSession.mockResolvedValue({ data: {}, error: null });
  });

  it('exchanges the code for a session and goes home', async () => {
    const response = await callback('?code=abc');
    expect(mocks.exchangeCodeForSession).toHaveBeenCalledExactlyOnceWith('abc');
    expect(response.status).toBe(307);
    expect(location(response)).toBe('http://localhost:3000/');
  });

  it('returns to a relative next path', async () => {
    const response = await callback('?code=abc&next=%2Fsetup%2Flink%3Fx%3D1');
    expect(location(response)).toBe('http://localhost:3000/setup/link?x=1');
  });

  it('never follows an absolute or protocol-relative next', async () => {
    for (const next of ['https://evil.example/', '//evil.example', '/\\evil.example']) {
      const response = await callback(`?code=abc&next=${encodeURIComponent(next)}`);
      expect(location(response), next).toBe('http://localhost:3000/');
    }
  });

  it('sends a failed exchange back to sign in with the link error, keeping next', async () => {
    mocks.exchangeCodeForSession.mockResolvedValueOnce({
      data: {},
      error: new Error('invalid flow state, no valid flow state found'),
    });
    const response = await callback('?code=stale&next=%2Fplan');
    expect(location(response)).toBe('http://localhost:3000/sign-in?next=/plan&error=link');
  });

  it('treats a missing code (an expired link Supabase rejected) as a link error', async () => {
    const response = await callback('?error=access_denied&error_code=otp_expired');
    expect(mocks.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(location(response)).toBe('http://localhost:3000/sign-in?error=link');
  });

  it('treats a thrown exchange (Auth unreachable) as a link error', async () => {
    mocks.exchangeCodeForSession.mockRejectedValueOnce(new TypeError('fetch failed'));
    const response = await callback('?code=abc');
    expect(location(response)).toBe('http://localhost:3000/sign-in?error=link');
  });

  it('reports a link error when Supabase is not configured', async () => {
    mocks.getSupabaseServerClient.mockResolvedValueOnce(null as never);
    const response = await callback('?code=abc');
    expect(location(response)).toBe('http://localhost:3000/sign-in?error=link');
  });
});
