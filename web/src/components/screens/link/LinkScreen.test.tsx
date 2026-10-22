import { http, HttpResponse } from 'msw';
import type { PlaidLinkOptionsWithLinkToken } from 'react-plaid-link';
import type { PlaidScriptState } from '@/lib/plaid-script';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_POLL_MS } from '@/lib/api/hooks';
import { installFakeXhr } from '@/test/fake-xhr';
import {
  BENEFITS_DOC_ID,
  PAY_STUB_DOC_ID,
  sampleBenefitsDocument,
  sampleDocument,
} from '@/test/fixtures/documents';
import { CHASE_ITEM_ID, CHECKING_ID, SAMPLE_NOW, sampleJob } from '@/test/fixtures/sample';
import { db, emptyDb, emptyDocuments } from '@/test/msw/db';
import {
  apiUrl,
  createDocument,
  recurringJobId,
  recurringJobStates,
  scriptJob,
} from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { act, renderWithProviders, screen, userEvent, waitFor, within } from '@/test/render';
import { LinkScreen } from './LinkScreen';

// Plaid Link is a third-party iframe: the test stands in for it and calls
// the callbacks Plaid would. Its script's state is a tiny store, so a test
// can let it finish loading part way through.
const plaid = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let waiting: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const state = {
    config: null as PlaidLinkOptionsWithLinkToken | null,
    open: vi.fn(),
    script: 'ready' as PlaidScriptState,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load: () =>
      state.script === 'loading'
        ? new Promise<void>((resolve, reject) => waiting.push({ resolve, reject }))
        : state.script === 'ready'
          ? Promise.resolve()
          : Promise.reject(new Error('Could not load Plaid Link')),
    setScript: (next: PlaidScriptState) => {
      state.script = next;
      for (const w of waiting) {
        if (next === 'ready') w.resolve();
        if (next === 'failed') w.reject(new Error('Could not load Plaid Link'));
      }
      if (next !== 'loading') waiting = [];
      for (const listener of listeners) listener();
    },
  };
  return state;
});
vi.mock('react-plaid-link', () => ({
  usePlaidLink: (config: PlaidLinkOptionsWithLinkToken) => {
    plaid.config = config;
    return { open: plaid.open, ready: config.token !== null, error: null, exit: vi.fn() };
  },
}));
vi.mock('@/lib/plaid-script', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    loadPlaidScript: plaid.load,
    usePlaidScript: () => useSyncExternalStore(plaid.subscribe, () => plaid.script),
  };
});

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
  plaid.setScript('ready');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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

  it('says the institution is unlinked, with no undo, and keeps focus on the card', async () => {
    const { user } = renderLink();
    await screen.findByRole('group', { name: 'Chase Total Checking' });
    await user.click(screen.getByRole('button', { name: 'Unlink Chase' }));
    await user.click(screen.getByRole('button', { name: 'Yes, unlink Chase' }));

    const done = await within(accountsCard()).findByRole('status');
    expect(done).toHaveTextContent(
      'Unlinked Chase. Its 2 accounts and their transactions were deleted.',
    );
    // Focus does not fall to the page when the Unlink button leaves with its institution.
    expect(done).toHaveFocus();
    expect(within(accountsCard()).queryByRole('button', { name: /Undo/ })).toBeNull();
  });

  it('says why an unlink failed and keeps the institution', async () => {
    server.use(
      http.delete(apiUrl('/sync/items/:id'), () =>
        HttpResponse.json(
          { error: { code: 'internal_error', message: 'Database is busy' } },
          { status: 500 },
        ),
      ),
    );
    const { user } = renderLink();
    await screen.findByRole('group', { name: 'Chase Total Checking' });
    await user.click(screen.getByRole('button', { name: 'Unlink Chase' }));
    await user.click(screen.getByRole('button', { name: 'Yes, unlink Chase' }));
    expect(await within(accountsCard()).findByRole('alert')).toHaveTextContent(
      'Could not unlink Chase. Database is busy',
    );
    expect(screen.getByRole('group', { name: 'Chase Total Checking' })).toBeInTheDocument();
  });

  it('follows the recurring detection the unlink queued until it ends', async () => {
    const jobId = scriptJob(recurringJobStates(recurringJobId(1)));
    const jobReads = requests('GET', `/jobs/${jobId}`);
    const { user } = renderLink();
    await screen.findByRole('group', { name: 'Chase Total Checking' });
    await user.click(screen.getByRole('button', { name: 'Unlink Chase' }));
    await user.click(screen.getByRole('button', { name: 'Yes, unlink Chase' }));

    const done = await within(accountsCard()).findByRole('status');
    await waitFor(() => expect(jobReads).toHaveLength(1));
    await poll();
    await poll();
    expect(jobReads).toHaveLength(3);
    // Succeeded: nothing more to read, and the done notice stays as it was.
    await poll();
    expect(jobReads).toHaveLength(3);
    expect(done).toHaveTextContent(
      'Unlinked Chase. Its 2 accounts and their transactions were deleted.',
    );
  });

  it('shows an empty state and holds the next step until an account exists', async () => {
    emptyDb();
    renderLink();
    expect(await screen.findByText(/No accounts linked yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue to spending/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Link a bank with Plaid' })).toBeEnabled();
  });

  it('lets the next step go to spending once accounts exist and nothing waits for review', async () => {
    emptyDocuments();
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

  it('waits for the Plaid Link script before opening Link, busy all the while', async () => {
    plaid.script = 'loading';
    plaidSucceeds();
    const tokens = requests('POST', '/sync/link-token');
    const { user } = renderLink();
    await screen.findByRole('group', { name: 'Chase Total Checking' });
    const button = screen.getByRole('button', { name: 'Link another bank with Plaid' });

    await user.click(button);
    await waitFor(() => expect(tokens).toHaveLength(1));
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(plaid.open).not.toHaveBeenCalled();

    act(() => plaid.setScript('ready'));
    await waitFor(() => expect(plaid.open).toHaveBeenCalledOnce());
  });

  it('says so when the Plaid Link script fails while a press waits for it', async () => {
    plaid.script = 'loading';
    const { user } = renderLink();
    await screen.findByRole('group', { name: 'Chase Total Checking' });
    const button = screen.getByRole('button', { name: 'Link another bank with Plaid' });
    await user.click(button);
    await waitFor(() => expect(button).toHaveAttribute('aria-busy', 'true'));

    act(() => plaid.setScript('failed'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load Plaid Link. Check your connection and reload the page.',
    );
    expect(button).not.toHaveAttribute('aria-busy');
    expect(plaid.open).not.toHaveBeenCalled();
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
    plaid.script = 'failed';
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

  it('hides the sandbox button without the flag', async () => {
    renderLink();
    await screen.findByRole('group', { name: 'Chase Total Checking' });
    expect(screen.queryByRole('button', { name: 'Link sandbox bank (test)' })).toBeNull();
  });

  it('opens and closes the CSV import next to the bank link', async () => {
    const { user } = renderLink();
    await screen.findByRole('group', { name: 'Chase Total Checking' });
    const toggle = within(accountsCard()).getByRole('button', { name: 'Import a CSV' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'Import a CSV' })).toBeNull();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = screen.getByRole('region', { name: 'Import a CSV' });
    expect(toggle).toHaveAttribute('aria-controls', panel.id);
    expect(within(panel).getByLabelText(/Choose a CSV file/)).toBeInTheDocument();

    await user.click(toggle);
    expect(screen.queryByRole('region', { name: 'Import a CSV' })).toBeNull();
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

const docsCard = () => screen.getByRole('region', { name: 'Documents' });
const pdf = (name = 'acme.pdf') =>
  new File(['%PDF-1.7 synthetic'], name, { type: 'application/pdf' });
const dropZone = () => within(docsCard()).getByLabelText(/Add (another|a) document/);
const firstStubRow = () => within(docsCard()).findAllByRole('group', { name: /^Pay stub/ });

describe('LinkScreen documents', () => {
  it('lists each document with its status, pages, upload time and redactions', async () => {
    db.documents = [
      sampleDocument(),
      sampleDocument({
        id: 'doc-reading',
        status: 'extracting',
        page_count: null,
        redaction_count: 0,
      }),
      sampleDocument({ id: 'doc-up', status: 'uploaded', page_count: null, redaction_count: 0 }),
      sampleDocument({
        id: 'doc-manual',
        status: 'manual_entry_required',
        status_reason: 'refused',
        redaction_count: 1,
      }),
      sampleDocument({ id: 'doc-done', status: 'confirmed', redaction_count: 0 }),
      sampleDocument({
        id: 'doc-failed',
        status: 'failed',
        status_reason: 'unreadable_file',
        page_count: null,
        redaction_count: 0,
      }),
      sampleBenefitsDocument,
    ];
    renderLink();
    const rows = await firstStubRow();
    expect(rows).toHaveLength(6);
    const [proposed, reading, uploaded, manual, confirmed, failedRow] = rows as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];

    expect(proposed).toHaveTextContent('Review needed');
    expect(proposed).toHaveTextContent('1 page · uploaded 2 minutes ago');
    expect(within(proposed).getByText('2 items redacted')).toBeInTheDocument();
    expect(within(proposed).getByRole('link', { name: 'Review pay stub' })).toHaveAttribute(
      'href',
      `/setup/confirm/${PAY_STUB_DOC_ID}`,
    );

    expect(reading).toHaveTextContent('Reading');
    expect(
      within(reading).getByRole('progressbar', { name: 'Reading pay stub' }),
    ).toBeInTheDocument();
    expect(within(reading).queryByText(/redacted/)).not.toBeInTheDocument();
    expect(within(reading).getByRole('button', { name: 'Replace pay stub' })).toBeDisabled();

    expect(uploaded).toHaveTextContent('Uploaded');
    expect(within(uploaded).getByRole('button', { name: 'Read pay stub' })).toBeEnabled();

    expect(manual).toHaveTextContent('Manual entry needed');
    expect(manual).toHaveTextContent('The AI declined to read this document');
    expect(within(manual).getByText('1 item redacted')).toBeInTheDocument();
    expect(within(manual).getByRole('link', { name: 'Enter pay stub fields' })).toHaveAttribute(
      'href',
      '/setup/confirm/doc-manual',
    );

    expect(confirmed).toHaveTextContent('Confirmed');
    expect(within(confirmed).getByText('0 items redacted')).toBeInTheDocument();
    expect(within(confirmed).queryByRole('link')).not.toBeInTheDocument();

    expect(failedRow).toHaveTextContent('Failed');
    expect(failedRow).toHaveTextContent('This file could not be opened.');

    const benefits = within(docsCard()).getByRole('group', { name: /^Benefits summary/ });
    expect(benefits).toHaveTextContent('Review needed');
    expect(benefits).not.toHaveTextContent('after alpha');
    expect(within(benefits).getByRole('link', { name: 'Review benefits summary' })).toHaveAttribute(
      'href',
      `/setup/confirm/${BENEFITS_DOC_ID}`,
    );

    expect(screen.getByRole('link', { name: /Review extracted fields/ })).toHaveAttribute(
      'href',
      `/setup/confirm/${PAY_STUB_DOC_ID}`,
    );
  });

  it('sends a benefits summary nothing could be read from to the decision cards', async () => {
    db.documents = [
      { ...sampleBenefitsDocument, status: 'manual_entry_required', status_reason: 'refused' },
    ];
    renderLink();
    const benefits = await within(docsCard()).findByRole('group', { name: /^Benefits summary/ });
    expect(benefits).toHaveTextContent(
      'Enter its plans on the health plan card and its match in your 401(k) plan details.',
    );
    expect(within(benefits).getByRole('link', { name: 'Go to decisions' })).toHaveAttribute(
      'href',
      '/setup/decisions',
    );
  });

  it('shows the empty state and the redaction notice for a new user', async () => {
    emptyDocuments();
    renderLink();
    expect(await within(docsCard()).findByText(/No documents yet/)).toBeInTheDocument();
    expect(docsCard()).toHaveTextContent(
      'Before any AI sees a page, SSNs and account numbers are blacked out.',
    );
    expect(dropZone()).toBeEnabled();
  });

  it('uploads with a progress bar, reads the file automatically and follows the job to review', async () => {
    const xhr = installFakeXhr();
    emptyDocuments();
    const extracts: string[] = [];
    server.events.on('request:start', ({ request }) => {
      const path = new URL(request.url).pathname;
      if (request.method === 'POST' && path.endsWith('/extract')) extracts.push(path);
    });
    const { user } = renderLink();
    await within(docsCard()).findByText(/No documents yet/);

    await user.upload(dropZone(), pdf());
    await waitFor(() => expect(xhr.requests).toHaveLength(1));
    expect(xhr.last().field('type')).toBe('pay_stub');
    const bar = within(docsCard()).getByRole('progressbar', { name: 'Uploading acme.pdf' });
    expect(bar).toHaveAttribute('aria-valuenow', '0');

    act(() => xhr.last().progress(40, 100));
    expect(bar).toHaveAttribute('aria-valuenow', '40');
    expect(within(docsCard()).getByText('40%')).toBeInTheDocument();

    const created = createDocument('pay_stub');
    act(() => xhr.last().respond(201, { document_id: created.id }));
    const reading = await within(docsCard()).findByRole('progressbar', {
      name: 'Reading pay stub',
    });
    await waitFor(() => expect(extracts).toHaveLength(1));
    expect(
      within(docsCard()).queryByRole('progressbar', { name: 'Uploading acme.pdf' }),
    ).toBeNull();

    await poll();
    await waitFor(() => expect(reading).toHaveAttribute('aria-valuenow', '50'));
    await poll();
    const [row] = await firstStubRow();
    await waitFor(() => expect(row).toHaveTextContent('Review needed'));
    expect(within(row!).getByText('2 items redacted')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Review extracted fields/ })).toHaveAttribute(
      'href',
      `/setup/confirm/${created.id}`,
    );
  });

  it('uploads as the chosen type', async () => {
    const xhr = installFakeXhr();
    const { user } = renderLink();
    await firstStubRow();
    await user.selectOptions(within(docsCard()).getByLabelText('Document type'), [
      'Benefits summary',
    ]);
    await user.upload(dropZone(), pdf('benefits.pdf'));
    await waitFor(() => expect(xhr.requests).toHaveLength(1));
    expect(xhr.last().field('type')).toBe('benefits');
  });

  it('says when to try again after too many uploads', async () => {
    const xhr = installFakeXhr();
    const { user } = renderLink();
    await firstStubRow();
    await user.upload(dropZone(), pdf());
    await waitFor(() => expect(xhr.requests).toHaveLength(1));
    act(() =>
      xhr.last().respond(
        429,
        {
          error: { code: 'rate_limited', message: 'Too many requests; try again in 1200 seconds' },
        },
        { 'Retry-After': '1200' },
      ),
    );
    const alert = await within(docsCard()).findByRole('alert');
    expect(alert).toHaveTextContent(
      'acme.pdf was not uploaded. You have reached the limit for now. Try again in about 20 minutes.',
    );
    expect(within(docsCard()).queryByRole('progressbar')).toBeNull();
    await user.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect(within(docsCard()).queryByRole('alert')).toBeNull();
  });

  it.each([
    [
      413,
      'file_too_large',
      'The file is larger than 10 MB',
      'The file is larger than 10 MB. Try a smaller scan.',
    ],
    [415, 'unsupported_media_type', 'Upload a PDF, PNG or JPEG', 'Upload a PDF, PNG or JPEG.'],
  ])('explains a %i in plain words', async (status, code, message, expected) => {
    const xhr = installFakeXhr();
    const { user } = renderLink();
    await firstStubRow();
    await user.upload(dropZone(), pdf('scan.pdf'));
    await waitFor(() => expect(xhr.requests).toHaveLength(1));
    act(() => xhr.last().respond(status, { error: { code, message } }));
    expect(await within(docsCard()).findByRole('alert')).toHaveTextContent(
      `scan.pdf was not uploaded. ${expected}`,
    );
  });

  it('refuses a dropped file of another type without uploading it', async () => {
    const xhr = installFakeXhr();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime, applyAccept: false });
    renderLink();
    await firstStubRow();
    await user.upload(dropZone(), new File(['x'], 'notes.docx', { type: 'application/msword' }));
    expect(await within(docsCard()).findByRole('alert')).toHaveTextContent(
      'notes.docx was not uploaded. Upload a PDF, PNG or JPEG.',
    );
    expect(xhr.requests).toHaveLength(0);
  });

  it('replaces a document with a new upload of the same type', async () => {
    const xhr = installFakeXhr();
    db.documents = [sampleBenefitsDocument];
    const { user } = renderLink();
    const row = await within(docsCard()).findByRole('group', { name: /^Benefits summary/ });
    await user.click(within(row).getByRole('button', { name: 'Replace benefits summary' }));
    await user.upload(within(row).getByLabelText('New benefits summary file'), pdf('new.pdf'));
    await waitFor(() => expect(xhr.requests).toHaveLength(1));
    expect(xhr.last().field('type')).toBe('benefits');
    expect((xhr.last().field('file') as File).name).toBe('new.pdf');
  });

  it('starts reading an uploaded document on request', async () => {
    db.documents = [sampleDocument({ status: 'uploaded', page_count: null, redaction_count: 0 })];
    const extracts = requests('POST', `/docs/${PAY_STUB_DOC_ID}/extract`);
    const { user } = renderLink();
    const [row] = await firstStubRow();
    await user.click(within(row!).getByRole('button', { name: 'Read pay stub' }));
    await waitFor(() => expect(extracts).toHaveLength(1));
    expect(
      await within(docsCard()).findByRole('progressbar', { name: 'Reading pay stub' }),
    ).toBeInTheDocument();
  });

  it('says so when reading cannot start, and keeps the upload', async () => {
    db.documents = [sampleDocument({ status: 'uploaded', page_count: null, redaction_count: 0 })];
    server.use(
      http.post(apiUrl('/docs/:id/extract'), () =>
        HttpResponse.json({ error: { code: 'x', message: 'Database is busy' } }, { status: 503 }),
      ),
    );
    const { user } = renderLink();
    const [row] = await firstStubRow();
    await user.click(within(row!).getByRole('button', { name: 'Read pay stub' }));
    expect(await within(docsCard()).findByRole('alert')).toHaveTextContent(
      'Could not start reading the pay stub. Database is busy',
    );
    expect(row).toHaveTextContent('Uploaded');
  });

  it('offers a retry when reading dies', async () => {
    db.documents = [sampleDocument({ status: 'uploaded', page_count: null, redaction_count: 0 })];
    server.use(
      http.post(apiUrl('/docs/:id/extract'), () => {
        const jobId = scriptJob([
          sampleJob({
            id: '5a000000-0000-4000-8000-0000000000df',
            kind: 'ingest.extract',
            status: 'dead',
          }),
        ]);
        db.documents[0]!.status = 'extracting';
        return HttpResponse.json({ job_id: jobId }, { status: 202 });
      }),
    );
    const { user } = renderLink();
    const [row] = await firstStubRow();
    await user.click(within(row!).getByRole('button', { name: 'Read pay stub' }));
    const alert = await within(docsCard()).findByRole('alert');
    expect(alert).toHaveTextContent('Reading pay stub did not finish.');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('follows a document that was already being read, by polling the list', async () => {
    db.documents = [sampleDocument({ status: 'extracting', page_count: null, redaction_count: 0 })];
    renderLink();
    const [row] = await firstStubRow();
    expect(within(row!).getByRole('progressbar', { name: 'Reading pay stub' })).toBeInTheDocument();
    db.documents = [sampleDocument()];
    await poll();
    await waitFor(() => expect(row).toHaveTextContent('Review needed'));
  });
});
