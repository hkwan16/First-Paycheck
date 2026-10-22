import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/test/msw/db';
import { apiUrl } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { act, renderHookWithClient, waitFor } from '@/test/render';

const mocks = vi.hoisted(() => {
  const auth = {
    getSession: vi.fn(),
    refreshSession: vi.fn(),
    signOut: vi.fn(),
  };
  return {
    auth,
    getSupabaseBrowserClient: vi.fn((): { auth: typeof auth } | null => ({ auth })),
    hardNavigate: vi.fn(),
  };
});
vi.mock('@/lib/supabase/client', () => ({
  getSupabaseBrowserClient: mocks.getSupabaseBrowserClient,
}));
vi.mock('@/lib/navigation', () => ({ hardNavigate: mocks.hardNavigate }));

import { useDeleteAccount } from './account';

beforeEach(() => {
  mocks.auth.getSession.mockResolvedValue({
    data: { session: { access_token: 'access-1' } },
    error: null,
  });
  mocks.auth.signOut.mockResolvedValue({ error: null });
});
afterEach(() => {
  vi.clearAllMocks();
  server.events.removeAllListeners();
});

describe('useDeleteAccount', () => {
  it('deletes the account, signs out locally and goes to sign in with the notice', async () => {
    const deletes: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'DELETE') deletes.push(new URL(request.url).pathname);
    });
    const { result } = renderHookWithClient(() => useDeleteAccount());
    act(() => result.current.mutate());
    await waitFor(() =>
      expect(mocks.hardNavigate).toHaveBeenCalledExactlyOnceWith('/sign-in?deleted=1'),
    );
    expect(deletes).toEqual(['/me']);
    expect(db.accounts).toEqual([]);
    expect(mocks.auth.signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
    // Signed out before the navigation starts.
    expect(mocks.auth.signOut.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.hardNavigate.mock.invocationCallOrder[0]!,
    );
  });

  it('keeps the person signed in and reports the reason when the delete fails', async () => {
    server.use(
      http.delete(apiUrl('/me'), () =>
        HttpResponse.json(
          { error: { code: 'internal_error', message: 'Database is busy' } },
          { status: 500 },
        ),
      ),
    );
    const { result } = renderHookWithClient(() => useDeleteAccount());
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ status: 500, code: 'internal_error' });
    expect(mocks.auth.signOut).not.toHaveBeenCalled();
    expect(mocks.hardNavigate).not.toHaveBeenCalled();
  });
});
