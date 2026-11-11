import { http, HttpResponse } from 'msw';
import createFetchClient from 'openapi-fetch';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { server } from '@/test/msw/server';
import {
  createAuthMiddleware,
  createSessionTokens,
  SESSION_READ_TIMEOUT_MS,
  SESSION_UNAVAILABLE_MESSAGE,
  SessionUnavailable,
  type SessionAuth,
} from './auth-middleware';

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

function clientWith(auth: SessionAuth, onSessionExpired = vi.fn(), onAccountDeleted = vi.fn()) {
  const client = createFetchClient<Paths>({
    baseUrl: BASE,
    fetch: (request) => globalThis.fetch(request),
  });
  client.use(
    createAuthMiddleware(
      createSessionTokens({ getAuth: () => auth, onSessionExpired, onAccountDeleted }),
    ),
  );
  return client;
}

const accountDeleted = () =>
  HttpResponse.json(
    { error: { code: 'account_deleted', message: 'This account has been deleted' } },
    { status: 401 },
  );

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

  it('signs out without a refresh when the account was deleted (401 account_deleted)', async () => {
    server.use(http.post(`${BASE}/echo`, accountDeleted));
    const auth = fakeAuth();
    const onSessionExpired = vi.fn();
    const onAccountDeleted = vi.fn();
    const { error, response } = await clientWith(auth, onSessionExpired, onAccountDeleted).POST(
      '/echo',
      { body: { note: 'hello' } },
    );
    expect(response.status).toBe(401);
    expect(error).toEqual({
      error: { code: 'account_deleted', message: 'This account has been deleted' },
    });
    expect(auth.refreshSession).not.toHaveBeenCalled();
    expect(auth.signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
    expect(onAccountDeleted).toHaveBeenCalledOnce();
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it('treats a 401 account_deleted after a refresh the same way', async () => {
    server.use(
      http.get(`${BASE}/ping`, ({ request }) =>
        isFresh(request) ? accountDeleted() : new HttpResponse(null, { status: 401 }),
      ),
    );
    const auth = fakeAuth();
    const onSessionExpired = vi.fn();
    const onAccountDeleted = vi.fn();
    await clientWith(auth, onSessionExpired, onAccountDeleted).GET('/ping');
    expect(onAccountDeleted).toHaveBeenCalledOnce();
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it('leaves a 401 account_deleted alone when auth is off', async () => {
    server.use(http.get(`${BASE}/ping`, accountDeleted));
    const onAccountDeleted = vi.fn();
    const client = createFetchClient<Paths>({ baseUrl: BASE, fetch: (r) => globalThis.fetch(r) });
    client.use(
      createAuthMiddleware(
        createSessionTokens({ getAuth: () => null, onSessionExpired: vi.fn(), onAccountDeleted }),
      ),
    );
    const { response } = await client.GET('/ping');
    expect(response.status).toBe(401);
    expect(onAccountDeleted).not.toHaveBeenCalled();
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

describe('createSessionTokens', () => {
  it('reads the current access token, or null when auth is off or signed out', async () => {
    const auth = fakeAuth();
    expect(
      await createSessionTokens({
        getAuth: () => auth,
        onSessionExpired: vi.fn(),
        onAccountDeleted: vi.fn(),
      }).current(),
    ).toBe('old');
    expect(
      await createSessionTokens({
        getAuth: () => null,
        onSessionExpired: vi.fn(),
        onAccountDeleted: vi.fn(),
      }).current(),
    ).toBeNull();
    auth.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
    expect(
      await createSessionTokens({
        getAuth: () => auth,
        onSessionExpired: vi.fn(),
        onAccountDeleted: vi.fn(),
      }).current(),
    ).toBeNull();
  });

  it('shares one refresh with the fetch middleware, so an upload and a read never race', async () => {
    server.use(
      http.get(`${BASE}/ping`, ({ request }) =>
        isFresh(request)
          ? HttpResponse.json({ ok: true })
          : new HttpResponse(null, { status: 401 }),
      ),
    );
    const auth = fakeAuth();
    // A refresh in flight while the read comes back 401.
    auth.refreshSession.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ data: { session: { access_token: 'new' } }, error: null }),
            30,
          ),
        ),
    );
    const tokens = createSessionTokens({
      getAuth: () => auth,
      onSessionExpired: vi.fn(),
      onAccountDeleted: vi.fn(),
    });
    const client = createFetchClient<Paths>({ baseUrl: BASE, fetch: (r) => globalThis.fetch(r) });
    client.use(createAuthMiddleware(tokens));
    const [read, refreshed] = await Promise.all([client.GET('/ping'), tokens.refreshed()]);
    expect(read.response.status).toBe(200);
    expect(refreshed).toBe('new');
    expect(auth.refreshSession).toHaveBeenCalledOnce();
  });

  it('signs out locally and reports the expiry', async () => {
    const auth = fakeAuth();
    const onSessionExpired = vi.fn();
    await createSessionTokens({
      getAuth: () => auth,
      onSessionExpired,
      onAccountDeleted: vi.fn(),
    }).expire();
    expect(auth.signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
    expect(onSessionExpired).toHaveBeenCalledOnce();
  });

  it('signs out locally and reports a deleted account, even when sign-out fails', async () => {
    const auth = fakeAuth();
    auth.signOut.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const onAccountDeleted = vi.fn();
    const onSessionExpired = vi.fn();
    await createSessionTokens({
      getAuth: () => auth,
      onSessionExpired,
      onAccountDeleted,
    }).accountDeleted();
    expect(auth.signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
    expect(onAccountDeleted).toHaveBeenCalledOnce();
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  describe('a session read or sign-out that never answers (issue 225)', () => {
    const never = () => new Promise<never>(() => undefined);

    afterEach(() => {
      vi.useRealTimers();
    });

    it('stops waiting for the session after SESSION_READ_TIMEOUT_MS, and says so', async () => {
      vi.useFakeTimers();
      const auth = fakeAuth();
      auth.getSession.mockImplementationOnce(never);
      const onSessionReadable = vi.fn();
      const tokens = createSessionTokens({
        getAuth: () => auth,
        onSessionExpired: vi.fn(),
        onAccountDeleted: vi.fn(),
        onSessionReadable,
      });
      const reading = tokens.current();
      const outcome = expect(reading).rejects.toBeInstanceOf(SessionUnavailable);
      await vi.advanceTimersByTimeAsync(SESSION_READ_TIMEOUT_MS);
      await outcome;
      await expect(reading).rejects.toMatchObject({
        status: 0,
        code: 'session_unavailable',
        error: { message: SESSION_UNAVAILABLE_MESSAGE },
      });
      expect(onSessionReadable).toHaveBeenLastCalledWith(false);

      // A later read that answers clears it.
      await expect(tokens.current()).resolves.toBe('old');
      expect(onSessionReadable).toHaveBeenLastCalledWith(true);
    });

    it('sends no request while the session cannot be read, and fails it instead', async () => {
      vi.useFakeTimers();
      const auth = fakeAuth();
      auth.getSession.mockImplementation(never);
      const sent = vi.fn();
      server.use(
        http.get(`${BASE}/ping`, () => {
          sent();
          return HttpResponse.json({ ok: true });
        }),
      );
      const request = clientWith(auth).GET('/ping');
      const outcome = expect(request).rejects.toBeInstanceOf(SessionUnavailable);
      await vi.advanceTimersByTimeAsync(SESSION_READ_TIMEOUT_MS);
      await outcome;
      expect(sent).not.toHaveBeenCalled();
    });

    it('treats a refresh that never answers as a failed one', async () => {
      vi.useFakeTimers();
      const auth = fakeAuth();
      auth.refreshSession.mockImplementationOnce(never);
      const tokens = createSessionTokens({
        getAuth: () => auth,
        onSessionExpired: vi.fn(),
        onAccountDeleted: vi.fn(),
      });
      const refreshing = tokens.refreshed();
      await vi.advanceTimersByTimeAsync(SESSION_READ_TIMEOUT_MS);
      await expect(refreshing).resolves.toBeNull();
    });

    it('still reports the expiry when the local sign-out never answers', async () => {
      vi.useFakeTimers();
      const auth = fakeAuth();
      auth.signOut.mockImplementationOnce(never);
      const onSessionExpired = vi.fn();
      const expiring = createSessionTokens({
        getAuth: () => auth,
        onSessionExpired,
        onAccountDeleted: vi.fn(),
      }).expire();
      await vi.advanceTimersByTimeAsync(SESSION_READ_TIMEOUT_MS);
      await expiring;
      expect(onSessionExpired).toHaveBeenCalledOnce();
    });
  });

  it('reports a deleted account when auth is off, with nothing to sign out', async () => {
    const onAccountDeleted = vi.fn();
    await createSessionTokens({
      getAuth: () => null,
      onSessionExpired: vi.fn(),
      onAccountDeleted,
    }).accountDeleted();
    expect(onAccountDeleted).toHaveBeenCalledOnce();
  });
});
