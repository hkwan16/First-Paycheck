import { http, HttpResponse } from 'msw';
import type { PlaidLinkOptionsWithLinkToken } from 'react-plaid-link';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_POLL_MS } from '@/lib/api/hooks';
import { CHASE_ITEM_ID, CHECKING_ID, SAMPLE_NOW, sampleJob } from '@/test/fixtures/sample';
import { db, emptyDb } from '@/test/msw/db';
import { apiUrl, scriptJob } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { act, renderWithProviders, screen, waitFor, within } from '@/test/render';
import { LinkScreen } from './LinkScreen';

// Plaid Link is a third-party iframe: the test stands in for it and calls
// the callbacks Plaid would.
const plaid = vi.hoisted(() => ({
  config: null as PlaidLinkOptionsWithLinkToken | null,
  open: vi.fn(),
  scriptError: null as ErrorEvent | null,
}));
vi.mock('react-plaid-link', () => ({
  usePlaidLink: (config: PlaidLinkOptionsWithLinkToken) => {
    plaid.config = config;
    return {
      open: plaid.open,
      ready: config.token !== null && !plaid.scriptError,
      error: plaid.scriptError,
      exit: vi.fn(),
    };
  },
}));

const platypus = {
  institution: { name: 'First Platypus Bank', institution_id: 'ins_109508' },
  accounts: [],
  link_session_id: 'session-1',
};

/** Link opens with the current token and returns a public token, like a completed Link flow. */
function plaidSucceeds() {
  const openedWith: (string | null | undefined)[] = [];
  plaid.open.mockImplementation(() => {
    openedWith.push(plaid.config?.token);
    plaid.config?.onSuccess('public-sandbox-1', platypus);
  });
  return openedWith;
}

function requests(method: string, path: string) {
  const bodies: unknown[] = [];
  server.events.on('request:start', async ({ request }) => {
    if (request.method === method && new URL(request.url).pathname === path) {
      bodies.push(
        request.headers.get('content-length') === '0' ? null : await request.clone().text(),
      );
    }
  });
  return bodies;
}

function renderLink(props: Parameters<typeof LinkScreen>[0] = {}) {
  return renderWithProviders(<LinkScreen {...props} />, {
    advanceTimers: vi.advanceTimersByTime,
  });
}

const accountsCard = () => screen.getByRole('region', { name: 'Bank accounts' });
const poll = () => act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(SAMPLE_NOW) });
  plaid.open.mockReset();
  plaid.config = null;
  plaid.scriptError = null;
});
afterEach(() => {
  vi.useRealTimers();
  server.events.removeAllListeners();
});

describe('LinkScreen accounts', () => {
  it('lists each account with its institution, mask, sync time, count and role', async () => {
    renderLink();
    const checking = await screen.findByRole('group', { name: 'Chase Total Checking' });
    expect(within(checking).getByText('··4821')).toBeInTheDocument();
    expect(within(checking).getByText('CH')).toBeInTheDocument();
    await waitFor(() =>
      expect(checking).toHaveTextContent('Synced 4 minutes ago · 16 transactions since Oct 2026'),
    );
    expect(within(checking).getByRole('combobox', { name: 'Role' })).toHaveValue('spending');

    const savings = screen.getByRole('group', { name: 'Chase Savings' });
    expect(savings).toHaveTextContent('Synced 4 minutes ago · Balance $2,140.00');
    expect(within(savings).getByRole('combobox', { name: 'Role' })).toHaveValue('emergency_fund');

    expect(within(accountsCard()).getByText('2 linked')).toBeInTheDocument();
  });

  it('saves a new role and shows the server result, including the moved emergency fund', async () => {
    const patches = requests('PATCH', `/accounts/${CHECKING_ID}`);
    const { user } = renderLink();
    const checking = await screen.findByRole('group', { name: 'Chase Total Checking' });
    await user.selectOptions(within(checking).getByRole('combobox', { name: 'Role' }), [
      'Emergency fund',
    ]);
    await waitFor(() => expect(patches).toEqual(['{"role":"emergency_fund","is_active":true}']));
    const savings = screen.getByRole('group', { name: 'Chase Savings' });
    await waitFor(() =>
      expect(within(savings).getByRole('combobox', { name: 'Role' })).toHaveValue(''),
    );
  });

  it('marks an account "Not used" by clearing its role and turning it off', async () => {
    const patches = requests('PATCH', `/accounts/${CHECKING_ID}`);
    const { user } = renderLink();
    const checking = await screen.findByRole('group', { name: 'Chase Total Checking' });
    await user.selectOptions(within(checking).getByRole('combobox', { name: 'Role' }), [
      'Not used',
    ]);
    await waitFor(() => expect(patches).toEqual(['{"role":null,"is_active":false}']));
    expect(within(checking).getByRole('combobox', { name: 'Role' })).toHaveValue('unused');
  });

  it('puts the role back and says so when saving fails', async () => {
    server.use(
      http.patch(apiUrl('/accounts/:id'), () =>
        HttpResponse.json({ error: { code: 'x', message: 'Database is busy' } }, { status: 503 }),
      ),
    );
    const { user } = renderLink();
    const checking = await screen.findByRole('group', { name: 'Chase Total Checking' });
    const select = within(checking).getByRole('combobox', { name: 'Role' });
    await user.selectOptions(select, ['Retirement']);
    expect(await within(checking).findByRole('alert')).toHaveTextContent(
      'Could not save the role. Database is busy',
    );
    expect(select).toHaveValue('spending');
  });

  it('asks before unlinking an institution, and unlinks only on confirmation', async () => {
    const deletes = requests('DELETE', `/sync/items/${CHASE_ITEM_ID}`);
    const { user } = renderLink();
    await screen.findByRole('group', { name: 'Chase Total Checking' });

    await user.click(screen.getByRole('button', { name: 'Unlink Chase' }));
    const confirm = screen.getByRole('group', { name: 'Unlink Chase?' });
    expect(confirm).toHaveTextContent('Its 2 accounts and their transactions will be deleted.');
    expect(within(confirm).getByRole('button', { name: 'Keep Chase' })).toHaveFocus();

    await user.click(within(confirm).getByRole('button', { name: 'Keep Chase' }));
    expect(screen.queryByRole('group', { name: 'Unlink Chase?' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unlink Chase' })).toHaveFocus();
    expect(deletes).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Unlink Chase' }));
    await user.click(screen.getByRole('button', { name: 'Yes, unlink Chase' }));
    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(await screen.findByText(/No accounts linked yet/)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Chase Total Checking' })).not.toBeInTheDocument();
  });

  it('shows an empty state and holds the next step until an account exists', async () => {
    emptyDb();
    renderLink();
    expect(await screen.findByText(/No accounts linked yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue to spending/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Link a bank with Plaid' })).toBeEnabled();
  });

  it('lets the next step go to spending once accounts exist', async () => {
    renderLink();
    await screen.findByRole('group', { name: 'Chase Total Checking' });
    expect(screen.getByRole('link', { name: /Continue to spending/ })).toHaveAttribute(
      'href',
      '/setup/spending',
    );
  });
});

describe('LinkScreen linking a bank', () => {
  it('gets a token, opens Plaid, links the item and follows the sync until rows appear', async () => {
    emptyDb();
    const openedWith = plaidSucceeds();
    const tokens = requests('POST', '/sync/link-token');
    const links = requests('POST', '/sync/items');
    const { user } = renderLink();
    await screen.findByText(/No accounts linked yet/);

    await user.click(screen.getByRole('button', { name: 'Link a bank with Plaid' }));
    await waitFor(() => expect(plaid.open).toHaveBeenCalledOnce());
    expect(tokens).toHaveLength(1);
    expect(openedWith).toEqual(['link-sandbox-test']);
    await waitFor(() =>
      expect(links).toEqual([
        '{"public_token":"public-sandbox-1","institution_name":"First Platypus Bank"}',
      ]),
    );

    const progress = await screen.findByRole('progressbar', {
      name: 'Syncing First Platypus Bank',
    });
    expect(screen.getByRole('status')).toHaveTextContent('Waiting to start');
    expect(progress).not.toHaveAttribute('aria-valuenow');

    await poll();
    await waitFor(() => expect(progress).toHaveAttribute('aria-valuenow', '40'));
    expect(screen.getByText('40%')).toBeInTheDocument();

    await poll();
    expect(
      await screen.findByRole('group', { name: 'Plaid Checking' }, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Plaid Saving' })).toBeInTheDocument();
    expect(
      screen.getByText(/Linked First Platypus Bank\. 12 new transactions synced\./),
    ).toBeVisible();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Continue to spending/ })).toBeInTheDocument();
  });

  it("shows Plaid Link's exit error as a warning", async () => {
    plaid.open.mockImplementation(() =>
      plaid.config?.onExit?.(
        {
          error_type: 'ITEM_ERROR',
          error_code: 'INVALID_CREDENTIALS',
          error_message: 'the provided credentials were not correct',
          display_message: 'The credentials were not correct. Please try again.',
        },
        {
          institution: null,
          status: 'requires_credentials',
          link_session_id: 's',
          request_id: 'r',
        },
      ),
    );
    const { user } = renderLink();
    await screen.findByRole('group', { name: 'Chase Total Checking' });
    await user.click(screen.getByRole('button', { name: 'Link another bank with Plaid' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Plaid Link closed. The credentials were not correct. Please try again.',
    );
  });

  it('says nothing when the person closes Plaid Link themselves', async () => {
    plaid.open.mockImplementation(() =>
      plaid.config?.onExit?.(null, {
        institution: null,
        status: null,
        link_session_id: 's',
        request_id: 'r',
      }),
    );
    const { user } = renderLink();
    await screen.findByRole('group', { name: 'Chase Total Checking' });
    await user.click(screen.getByRole('button', { name: 'Link another bank with Plaid' }));
    await waitFor(() => expect(plaid.open).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Link another bank with Plaid' })).toBeEnabled();
  });

  it("reports the API's reason when a link token cannot be made", async () => {
    server.use(
      http.post(apiUrl('/sync/link-token'), () =>
        HttpResponse.json(
          {
            error: {
              code: 'plaid_unavailable',
              message: 'Plaid is unavailable; try again shortly',
            },
          },
          { status: 503 },
        ),
      ),
    );
    const { user } = renderLink();
    await screen.findByRole('group', { name: 'Chase Total Checking' });
    await user.click(screen.getByRole('button', { name: 'Link another bank with Plaid' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not start Plaid Link. Plaid is unavailable; try again shortly',
    );
    expect(plaid.open).not.toHaveBeenCalled();
  });

  it('says so when the Plaid Link script could not load', async () => {
    plaid.scriptError = new ErrorEvent('error');
    const tokens = requests('POST', '/sync/link-token');
    const { user } = renderLink();
    await screen.findByRole('group', { name: 'Chase Total Checking' });
    await user.click(screen.getByRole('button', { name: 'Link another bank with Plaid' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load Plaid Link. Check your connection and reload the page.',
    );
    expect(tokens).toEqual([]);
  });

  it('offers a retry when the sync dies, and follows the new job', async () => {
    emptyDb();
    plaidSucceeds();
    server.use(
      http.post(apiUrl('/sync/items'), () => {
        const jobId = scriptJob([
          sampleJob({ id: '5a000000-0000-4000-8000-0000000000de', status: 'dead' }),
        ]);
        return HttpResponse.json(
          {
            item: {
              id: 'item-dead',
              provider: 'plaid',
              institution_name: 'First Platypus Bank',
              status: 'active',
              last_synced_at: null,
              created_at: SAMPLE_NOW,
            },
            job_id: jobId,
          },
          { status: 201 },
        );
      }),
      http.post(apiUrl('/sync/items/item-dead/sync'), () => {
        const jobId = scriptJob([
          sampleJob({
            id: '5a000000-0000-4000-8000-0000000000ee',
            status: 'running',
            progress: 10,
          }),
        ]);
        return HttpResponse.json({ job_id: jobId }, { status: 202 });
      }),
    );
    const { user } = renderLink();
    await screen.findByText(/No accounts linked yet/);
    await user.click(screen.getByRole('button', { name: 'Link a bank with Plaid' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Syncing First Platypus Bank did not finish.');

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    const bar = await screen.findByRole('progressbar', { name: 'Syncing First Platypus Bank' });
    await waitFor(() => expect(bar).toHaveAttribute('aria-valuenow', '10'));
  });

  it('links the sandbox bank without Plaid Link when the e2e flag is on', async () => {
    const links = requests('POST', '/sync/items');
    const { user } = renderLink({ showSandboxLink: true });
    await screen.findByRole('group', { name: 'Chase Total Checking' });
    await user.click(screen.getByRole('button', { name: 'Link sandbox bank (test)' }));
    await waitFor(() => expect(links).toEqual(['{"sandbox_institution_id":"ins_109508"}']));
    expect(plaid.open).not.toHaveBeenCalled();
    expect(
      await screen.findByRole('progressbar', { name: 'Syncing First Platypus Bank' }),
    ).toBeInTheDocument();
  });

  it('hides the sandbox button without the flag, and keeps CSV import for after alpha', async () => {
    renderLink();
    await screen.findByRole('group', { name: 'Chase Total Checking' });
    expect(screen.queryByRole('button', { name: 'Link sandbox bank (test)' })).toBeNull();
    expect(screen.getByRole('button', { name: /Import a CSV instead/ })).toBeDisabled();
    expect(within(accountsCard()).getByText('After alpha')).toBeInTheDocument();
  });

  it('syncs an institution on demand', async () => {
    const syncs = requests('POST', `/sync/items/${CHASE_ITEM_ID}/sync`);
    const { user } = renderLink();
    await screen.findByRole('group', { name: 'Chase Total Checking' });
    await user.click(screen.getByRole('button', { name: 'Sync now for Chase' }));
    await waitFor(() => expect(syncs).toHaveLength(1));
    expect(await screen.findByRole('progressbar', { name: 'Syncing Chase' })).toBeInTheDocument();
    expect(db.accounts).toHaveLength(2);
  });
});

describe('LinkScreen documents', () => {
  it('shows the empty state, the redaction notice and a disabled upload until uploads land', async () => {
    renderLink();
    const docs = screen.getByRole('region', { name: 'Documents' });
    expect(within(docs).getByText(/No documents yet/)).toBeInTheDocument();
    expect(within(docs).getByText('Coming next')).toBeInTheDocument();
    expect(within(docs).getByLabelText(/Add a pay stub or benefits summary/)).toBeDisabled();
    expect(docs).toHaveTextContent(
      'Before any AI sees a page, SSNs and account numbers are blacked out.',
    );
  });
});
