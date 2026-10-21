// @vitest-environment node
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const getClaims = vi.fn(async () => ({ data: null, error: null }));
  return { getClaims, createServerClient: vi.fn(() => ({ auth: { getClaims } })) };
});
vi.mock('@supabase/ssr', () => ({ createServerClient: mocks.createServerClient }));

import { config, proxy } from './proxy';

const forwarded = (response: Response, name: string) =>
  response.headers.get(`x-middleware-request-${name}`);

describe('proxy', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://x.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
  });

  it('passes the request through untouched when Supabase is not configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    const response = await proxy(new NextRequest('http://localhost:3000/plan'));
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(mocks.createServerClient).not.toHaveBeenCalled();
  });

  it('refreshes the Supabase session on every matched request', async () => {
    await proxy(new NextRequest('http://localhost:3000/plan'));
    expect(mocks.createServerClient).toHaveBeenCalledOnce();
    expect(mocks.getClaims).toHaveBeenCalledOnce();
  });

  it('tells the app which path was requested, so the guard can send people back to it', async () => {
    const response = await proxy(
      new NextRequest('http://localhost:3000/plan?tab=goals&_rsc=1x', {
        headers: { 'x-first-paycheck-path': '/spoofed' },
      }),
    );
    expect(forwarded(response, 'x-first-paycheck-path')).toBe('/plan?tab=goals');
  });

  it('forwards the path even when Supabase is not configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
    const response = await proxy(new NextRequest('http://localhost:3000/setup/link'));
    expect(forwarded(response, 'x-first-paycheck-path')).toBe('/setup/link');
  });
});

describe('proxy matcher', () => {
  const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url });

  it('runs on pages, the auth callback and client navigations', () => {
    for (const url of [
      '/',
      '/sign-in?next=/setup/link',
      '/plan',
      '/setup/confirm/doc_1',
      '/auth/callback?code=abc',
    ]) {
      expect(matches(url), url).toBe(true);
    }
  });

  it('skips Next build assets, image optimization, the favicon and any file with an extension', () => {
    for (const url of [
      '/_next/static/chunks/app.js',
      '/_next/image?url=%2Flogo.png&w=64&q=75',
      '/favicon.ico',
      '/logo.svg',
      '/robots.txt',
      '/fonts/inter.woff2',
      '/site.webmanifest',
    ]) {
      expect(matches(url), url).toBe(false);
    }
  });
});
