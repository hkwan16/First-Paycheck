import { http, HttpResponse } from 'msw';
import createFetchClient from 'openapi-fetch';
import { describe, expect, it, vi } from 'vitest';
import { server } from '@/test/msw/server';
import { createAuthMiddleware, type SessionAuth } from './auth-middleware';

const BASE = 'http://api.test';

interface Paths {
  '/echo': {
    post: {
      requestBody: { content: { 'application/json': { note: string } } };
      responses: { 200: { content: { 'application/json': { note: string } } } };
    };
  };
  '/ping': {
    get: { responses: { 200: { content: { 'application/json': { ok: boolean } } } } };
  };
}

function fakeAuth(): SessionAuth & { [K in keyof SessionAuth]: ReturnType<typeof vi.fn> } {
  return {
    getSession: vi.fn(async () => ({ data: { session: { access_token: 'old' } }, error: null })),
    refreshSession: vi.fn(async () => ({
      data: { session: { access_token: 'new' } },
      error: null,
    })),
    signOut: vi.fn(async () => ({ error: null })),
  } as never;
}

function clientWith(auth: SessionAuth, onSessionExpired = vi.fn()) {
  const client = createFetchClient<Paths>({
    baseUrl: BASE,
    fetch: (request) => globalThis.fetch(request),
  });
  client.use(createAuthMiddleware({ getAuth: () => auth, onSessionExpired }));
  return client;
}

const isFresh = (request: Request) => request.headers.get('authorization') === 'Bearer new';

describe('createAuthMiddleware', () => {
  it('resends the original body when it retries after a refresh', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(`${BASE}/echo`, async ({ request }) => {
        const body = await request.json();
        bodies.push(body);
        return isFresh(request) ? HttpResponse.json(body) : new HttpResponse(null, { status: 401 });
      }),
    );
    const { data } = await clientWith(fakeAuth()).POST('/echo', { body: { note: 'hello' } });
    expect(data).toEqual({ note: 'hello' });
    expect(bodies).toEqual([{ note: 'hello' }, { note: 'hello' }]);
  });

  it('shares one refresh between requests that fail together', async () => {
    server.use(
      http.get(`${BASE}/ping`, ({ request }) =>
        isFresh(request)
          ? HttpResponse.json({ ok: true })
          : new HttpResponse(null, { status: 401 }),
      ),
    );
    const auth = fakeAuth();
    const client = clientWith(auth);
    const results = await Promise.all([
      client.GET('/ping'),
      client.GET('/ping'),
      client.GET('/ping'),
    ]);
    expect(results.map((r) => r.response.status)).toEqual([200, 200, 200]);
    expect(auth.refreshSession).toHaveBeenCalledOnce();
  });

  it('refreshes again for a later 401 once the first refresh has settled', async () => {
    server.use(http.get(`${BASE}/ping`, () => new HttpResponse(null, { status: 401 })));
    const auth = fakeAuth();
    const onSessionExpired = vi.fn();
    const client = clientWith(auth, onSessionExpired);
    await client.GET('/ping');
    await client.GET('/ping');
    expect(auth.refreshSession).toHaveBeenCalledTimes(2);
    expect(onSessionExpired).toHaveBeenCalledTimes(2);
  });

  it('still reports the expiry when clearing the session fails', async () => {
    server.use(http.get(`${BASE}/ping`, () => new HttpResponse(null, { status: 401 })));
    const auth = fakeAuth();
    auth.signOut.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const onSessionExpired = vi.fn();
    await clientWith(auth, onSessionExpired).GET('/ping');
    expect(onSessionExpired).toHaveBeenCalledOnce();
  });
});
