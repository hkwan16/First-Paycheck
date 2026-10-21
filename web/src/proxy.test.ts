// @vitest-environment node
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const updateSession = vi.hoisted(() => vi.fn(async () => new Response(null)));
vi.mock('@/lib/supabase/proxy', () => ({ updateSession }));

import { config, proxy } from './proxy';

describe('proxy', () => {
  it('refreshes the Supabase session for the request', async () => {
    const request = new NextRequest('http://localhost:3000/plan');
    await proxy(request);
    expect(updateSession).toHaveBeenCalledWith(request);
  });

  it('skips static assets', () => {
    const [pattern] = config.matcher;
    const matches = (path: string) => new RegExp(`^${pattern}$`).test(path);
    expect(matches('/plan')).toBe(true);
    expect(matches('/setup/confirm/doc_1')).toBe(true);
    expect(matches('/_next/static/chunk.js')).toBe(false);
    expect(matches('/favicon.ico')).toBe(false);
    expect(matches('/logo.svg')).toBe(false);
  });
});
