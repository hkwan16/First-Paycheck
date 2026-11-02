import { delay, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buttonClasses } from '@/components/ui/Button';
import { JOB_POLL_MS } from '@/lib/api/hooks';
import { SAMPLE_NOW } from '@/test/fixtures/sample';
import { apiUrl } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { act, renderWithProviders, screen, within } from '@/test/render';
import { LinkScreen } from './LinkScreen';

// Plaid Link never opens here: its script is ready and the widget is inert.
vi.mock('react-plaid-link', () => ({
  usePlaidLink: () => ({ open: vi.fn(), ready: false, error: null, exit: vi.fn() }),
}));
vi.mock('@/lib/plaid-script', () => ({
  loadPlaidScript: () => Promise.resolve(),
  usePlaidScript: () => 'ready',
}));

const accountsCard = () => screen.getByRole('region', { name: 'Bank accounts' });
const chase = () => within(accountsCard()).getByRole('region', { name: 'Chase' });
/** The classes a variant adds to the default button's (no status color named here). */
const variantClasses = (variant: 'primary' | 'destructive') => {
  const base = new Set(buttonClasses().split(' '));
  return buttonClasses({ variant })
    .split(' ')
    .filter((name) => !base.has(name));
};
const poll = () => act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));

function renderLink() {
  return renderWithProviders(<LinkScreen showSandboxLink={false} />, {
    advanceTimers: vi.advanceTimersByTime,
  });
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(SAMPLE_NOW) }));
afterEach(() => vi.useRealTimers());

describe('AccountsCard', () => {
  it("shows a sync's progress and result beside that institution's Sync now (issue 208)", async () => {
    const { user } = renderLink();
    await screen.findByRole('group', { name: 'Chase Total Checking' });
    await user.click(within(chase()).getByRole('button', { name: 'Sync now for Chase' }));

    expect(
      await within(chase()).findByRole('progressbar', { name: 'Syncing Chase' }),
    ).toBeInTheDocument();
    await poll();
    await poll();
    expect(await within(chase()).findByRole('status')).toHaveTextContent(
      'Synced Chase. 12 new transactions.',
    );
  });

  it('makes Keep the strong choice and Unlink the destructive one (issue 205)', async () => {
    const { user } = renderLink();
    await screen.findByRole('group', { name: 'Chase Total Checking' });
    await user.click(screen.getByRole('button', { name: 'Unlink Chase' }));
    const confirm = screen.getByRole('group', { name: 'Unlink Chase?' });
    const keep = within(confirm).getByRole('button', { name: 'Keep Chase' });
    const unlink = within(confirm).getByRole('button', { name: 'Yes, unlink Chase' });
    expect(keep).toHaveClass(...variantClasses('primary'));
    expect(unlink).toHaveClass(...variantClasses('destructive'));
  });

  it('asks for no account while the accounts are still loading (issue 196)', async () => {
    server.use(
      http.get(apiUrl('/accounts'), async () => {
        await delay('infinite');
      }),
    );
    renderLink();
    expect(await within(accountsCard()).findByText('Loading your accounts')).toBeInTheDocument();
    expect(screen.queryByText(/No accounts linked yet/)).not.toBeInTheDocument();
    expect(screen.queryByText('Link an account to continue')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue to spending/ })).toBeDisabled();
  });
});
