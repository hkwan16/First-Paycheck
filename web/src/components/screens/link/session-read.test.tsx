import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProblemNotice } from '@/components/chrome/SessionProblemNotice';
import { SESSION_READ_TIMEOUT_MS, SESSION_UNAVAILABLE_MESSAGE } from '@/lib/api/auth-middleware';
import { sessionStatus } from '@/lib/api/session-status';
import { makeQueryClient } from '@/lib/query-client';
import { SAMPLE_NOW } from '@/test/fixtures/sample';
import { server } from '@/test/msw/server';
import { act, renderWithProviders, screen, within } from '@/test/render';
import { LinkScreen } from './LinkScreen';

/*
 * The Link screen when the browser cannot read its Supabase session (issue
 * 225): supabase-js's getSession() waits on a token refresh that has no
 * timeout, and every request waits on that read. Seen once as "Loading your
 * accounts" and "Loading your documents" for over a minute with no request
 * to the API. The app's own QueryClient is used, so its retry rule is part of
 * what is tested: the cards must settle after one timeout, not two.
 */

const mocks = vi.hoisted(() => ({
  auth: { getSession: vi.fn(), refreshSession: vi.fn(), signOut: vi.fn() },
}));
vi.mock('@/lib/supabase/client', () => ({
  getSupabaseBrowserClient: () => ({ auth: mocks.auth }),
}));
vi.mock('@/lib/navigation', () => ({ hardNavigate: vi.fn(), reloadPage: vi.fn() }));
// Plaid Link never opens here: its script is ready and the widget is inert.
vi.mock('react-plaid-link', () => ({
  usePlaidLink: () => ({ open: vi.fn(), ready: false, error: null, exit: vi.fn() }),
}));
vi.mock('@/lib/plaid-script', () => ({
  loadPlaidScript: () => Promise.resolve(),
  usePlaidScript: () => 'ready',
}));

const NAME = 'We could not check that you are signed in.';

/** The paths of every request that reaches the API from now on. */
function apiRequests() {
  const paths: string[] = [];
  server.events.on('request:start', ({ request }) => {
    paths.push(new URL(request.url).pathname);
  });
  return paths;
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(SAMPLE_NOW) }));
afterEach(() => {
  vi.useRealTimers();
  server.events.removeAllListeners();
  act(() => sessionStatus.report(true));
});

describe('the Link screen when the session read never answers (issue 225)', () => {
  it('ends both skeletons after the timeout with why, and a way out, sending nothing', async () => {
    mocks.auth.getSession.mockImplementation(() => new Promise(() => undefined));
    const requests = apiRequests();
    renderWithProviders(
      <>
        <SessionProblemNotice />
        <LinkScreen showSandboxLink={false} />
      </>,
      { queryClient: makeQueryClient(), advanceTimers: vi.advanceTimersByTime },
    );
    const accounts = screen.getByRole('region', { name: 'Bank accounts' });
    const documents = screen.getByRole('region', { name: 'Documents' });
    expect(within(accounts).getByText('Loading your accounts')).toBeInTheDocument();
    expect(within(documents).getByText('Loading your documents')).toBeInTheDocument();
    expect(screen.queryByRole('alert', { name: NAME })).toBeNull();

    // Still waiting on the session a moment before the timeout.
    await act(() => vi.advanceTimersByTimeAsync(SESSION_READ_TIMEOUT_MS - 1));
    expect(within(accounts).getByText('Loading your accounts')).toBeInTheDocument();
    expect(within(documents).getByText('Loading your documents')).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(within(accounts).queryByText('Loading your accounts')).toBeNull();
    expect(within(documents).queryByText('Loading your documents')).toBeNull();
    expect(within(accounts).getByRole('alert')).toHaveTextContent(
      `Could not load your accounts. ${SESSION_UNAVAILABLE_MESSAGE}`,
    );
    expect(within(documents).getByRole('alert')).toHaveTextContent(
      `Could not load your documents. ${SESSION_UNAVAILABLE_MESSAGE}`,
    );

    // Once for the page: why nothing loads, and the two ways out.
    const notice = screen.getByRole('alert', { name: NAME });
    expect(within(notice).getByRole('button', { name: 'Reload the page' })).toBeInTheDocument();
    expect(within(notice).getByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
    expect(sessionStatus.readable()).toBe(false);

    // Nothing was sent with a session nobody could read.
    expect(requests.filter((path) => path === '/accounts' || path === '/docs')).toEqual([]);
  });
});
