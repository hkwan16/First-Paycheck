import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '@/test/msw/server';
import { apiUrl } from '@/test/msw/handlers';

const mocks = vi.hoisted(() => {
  const auth = {
    getSession: vi.fn(),
    refreshSession: vi.fn(),
    signOut: vi.fn(),
  };
  return {
    auth,
    getSupabaseBrowserClient: vi.fn((): { auth: typeof auth } | null => null),
    hardNavigate: vi.fn(),
  };
});
vi.mock('@/lib/supabase/client', () => ({
  getSupabaseBrowserClient: mocks.getSupabaseBrowserClient,
}));
vi.mock('@/lib/navigation', () => ({ hardNavigate: mocks.hardNavigate }));

import { fetchClient } from './client';

const HEALTH = { status: 'ok', git_sha: 'test', alembic_revision: '0001_roles' };
const sessionWith = (token: string) => ({
  data: { session: { access_token: token } },
  error: null,
});

/** /health answers 200 only for these bearer tokens and records what it saw. */
function healthAcceptingTokens(...accepted: string[]) {
  const seen: (string | null)[] = [];
  server.use(
    http.get(apiUrl('/health'), ({ request }) => {
      const header = request.headers.get('authorization');
      seen.push(header);
      return accepted.some((token) => header === `Bearer ${token}`)
        ? HttpResponse.json(HEALTH)
        : HttpResponse.json({ error: { code: 'unauthorized', message: 'no' } }, { status: 401 });
    }),
  );
  return seen;
}

describe('fetchClient', () => {
  it('reads GET /health through the typed client', async () => {
    const { data, error } = await fetchClient.GET('/health');
    expect(error).toBeUndefined();
    expect(data).toEqual(HEALTH);
  });

  it('surfaces the API error shape instead of throwing', async () => {
    server.use(
      http.get(apiUrl('/health'), () =>
        HttpResponse.json({ error: { code: 'unavailable', message: 'db down' } }, { status: 503 }),
      ),
    );
    const { data, error, response } = await fetchClient.GET('/health');
    expect(data).toBeUndefined();
    expect(response.status).toBe(503);
    expect(error).toEqual({ error: { code: 'unavailable', message: 'db down' } });
  });

  it('sends no token and never redirects when Supabase is not configured', async () => {
    const seen = healthAcceptingTokens();
    const { response } = await fetchClient.GET('/health');
    expect(response.status).toBe(401);
    expect(seen).toEqual([null]);
    expect(mocks.hardNavigate).not.toHaveBeenCalled();
  });
});

describe('fetchClient with a Supabase session', () => {
  beforeEach(() => {
    mocks.getSupabaseBrowserClient.mockReturnValue({ auth: mocks.auth });
    mocks.auth.getSession.mockResolvedValue(sessionWith('access-1'));
    mocks.auth.refreshSession.mockResolvedValue(sessionWith('access-2'));
    mocks.auth.signOut.mockResolvedValue({ error: null });
    window.history.pushState({}, '', '/plan?tab=goals');
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('attaches the access token as a bearer header on every request', async () => {
    const seen = healthAcceptingTokens('access-1');
    await fetchClient.GET('/health');
    await fetchClient.GET('/health');
    expect(seen).toEqual(['Bearer access-1', 'Bearer access-1']);
    expect(mocks.auth.refreshSession).not.toHaveBeenCalled();
  });

  it('sends no Authorization header without a session', async () => {
    mocks.auth.getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
    const seen = healthAcceptingTokens('access-1');
    server.use(http.get(apiUrl('/health'), () => HttpResponse.json(HEALTH)));
    await fetchClient.GET('/health');
    expect(seen).toEqual([]);
  });

  it('on a 401, refreshes the session once and retries with the new token', async () => {
    const seen = healthAcceptingTokens('access-2');
    const { data, response } = await fetchClient.GET('/health');
    expect(response.status).toBe(200);
    expect(data).toEqual(HEALTH);
    expect(seen).toEqual(['Bearer access-1', 'Bearer access-2']);
    expect(mocks.auth.refreshSession).toHaveBeenCalledOnce();
    expect(mocks.hardNavigate).not.toHaveBeenCalled();
  });

  it('on a second 401, clears the session and sends the person to sign in', async () => {
    const seen = healthAcceptingTokens();
    const { response, error } = await fetchClient.GET('/health');
    expect(response.status).toBe(401);
    expect(error).toEqual({ error: { code: 'unauthorized', message: 'no' } });
    expect(seen).toHaveLength(2);
    expect(mocks.auth.refreshSession).toHaveBeenCalledOnce();
    expect(mocks.auth.signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
    expect(mocks.hardNavigate).toHaveBeenCalledExactlyOnceWith('/sign-in?next=/plan%3Ftab%3Dgoals');
  });

  it('sends the person to sign in without a retry when the refresh fails', async () => {
    mocks.auth.refreshSession.mockResolvedValueOnce({
      data: { session: null },
      error: new Error('Invalid Refresh Token: Already Used'),
    });
    const seen = healthAcceptingTokens('access-2');
    const { response } = await fetchClient.GET('/health');
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(1);
    expect(mocks.auth.signOut).toHaveBeenCalledOnce();
    expect(mocks.hardNavigate).toHaveBeenCalledOnce();
  });

  it('signs out and says so on sign in when the account was deleted (401 account_deleted)', async () => {
    server.use(
      http.put(apiUrl('/profile'), () =>
        HttpResponse.json(
          { error: { code: 'account_deleted', message: 'This account has been deleted' } },
          { status: 401 },
        ),
      ),
    );
    const { response } = await fetchClient.PUT('/profile', {
      body: { dependents: 0 },
    });
    expect(response.status).toBe(401);
    expect(mocks.auth.refreshSession).not.toHaveBeenCalled();
    expect(mocks.auth.signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
    expect(mocks.hardNavigate).toHaveBeenCalledExactlyOnceWith('/sign-in?deleted=1');
  });

  it('leaves other errors alone', async () => {
    server.use(http.get(apiUrl('/health'), () => new HttpResponse(null, { status: 403 })));
    const { response } = await fetchClient.GET('/health');
    expect(response.status).toBe(403);
    expect(mocks.auth.refreshSession).not.toHaveBeenCalled();
    expect(mocks.hardNavigate).not.toHaveBeenCalled();
  });
});
