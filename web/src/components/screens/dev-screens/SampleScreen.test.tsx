import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_POLL_MS, useAccounts, useCalc } from '@/lib/api/hooks';
import { sampleK401, sampleK401Inputs } from '@/test/fixtures/decisions';
import { SAMPLE_NOW, sampleAccounts } from '@/test/fixtures/sample';
import { server } from '@/test/msw/server';
import { SampleScreen, seededClient } from './SampleScreen';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('react-plaid-link', () => ({
  usePlaidLink: () => ({ open: vi.fn(), ready: false, error: null, exit: vi.fn() }),
}));

function countRequests() {
  const seen: string[] = [];
  server.events.on('request:start', ({ request }) => {
    seen.push(`${request.method} ${new URL(request.url).pathname}`);
  });
  return seen;
}

describe('SampleScreen', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(SAMPLE_NOW) }));
  afterEach(() => {
    vi.useRealTimers();
    server.events.removeAllListeners();
  });

  it('renders the Link screen in the app frame from the sample data, with no requests', async () => {
    const requests = countRequests();
    render(<SampleScreen screen="link" />);
    expect(screen.getByText('Acme Corp · Semi-monthly')).toBeInTheDocument();
    expect(screen.getByText('J. Rivera')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Accounts and documents' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const checking = await screen.findByRole('group', { name: 'Chase Total Checking' });
    expect(checking).toHaveTextContent('16 transactions since Oct 2026');
    expect(requests).toEqual([]);
  });

  it('renders the Spending screen from the sample data with the Sankey on, with no requests', async () => {
    const requests = countRequests();
    render(<SampleScreen screen="spending" />);
    const table = await screen.findByRole('table', { name: 'Transactions' });
    expect(within(table).getAllByRole('row')).toHaveLength(17);
    expect(screen.getByRole('link', { name: 'Spending map' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('region', { name: 'October 1 to 17 · 2 paychecks' })).toHaveTextContent(
      '$3,992.08',
    );
    const flow = screen.getByRole('region', { name: 'Where each dollar of October pay went' });
    expect(within(flow).getByRole('button', { name: 'Take-home $3,992.08' })).toBeInTheDocument();
    const recurring = screen.getByRole('region', { name: 'Recurring charges' });
    expect(within(recurring).getAllByRole('listitem')).toHaveLength(5);
    expect(requests).toEqual([]);
  });

  it('renders the Confirm screen on the sample stub, with no requests', async () => {
    const requests = countRequests();
    render(<SampleScreen screen="confirm" />);
    const fields = await screen.findByRole('region', { name: 'Extracted fields' });
    expect(within(fields).getAllByRole('group')).toHaveLength(14);
    expect(screen.getByText('2 items redacted')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Confirm pay stub' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(requests).toEqual([]);
  });

  it('renders the benefits summary review, with no requests', async () => {
    const requests = countRequests();
    render(<SampleScreen screen="confirm-benefits" />);
    const fields = await screen.findByRole('region', { name: 'Plans and 401(k) match' });
    expect(fields).toHaveTextContent('0 of 21 confirmed');
    expect(within(fields).getByRole('heading', { name: 'Plan 2: Gold PPO' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Redacted benefits summary' })).toBeInTheDocument();
    expect(requests).toEqual([]);
  });

  it('renders the manual entry variant with every field open, with no requests', async () => {
    const requests = countRequests();
    render(<SampleScreen screen="confirm-manual" />);
    const fields = await screen.findByRole('region', { name: 'Pay stub fields' });
    expect(within(fields).getAllByRole('textbox')).toHaveLength(10);
    expect(requests).toEqual([]);
  });
});

describe('SampleScreen after Confirm', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(SAMPLE_NOW) }));
  afterEach(() => {
    vi.useRealTimers();
    server.events.removeAllListeners();
  });

  it('renders the Decisions screen on the saved decisions, with no requests', async () => {
    const requests = countRequests();
    render(<SampleScreen screen="decisions" />);
    const card = await screen.findByRole('region', { name: '401(k) match' });
    expect(within(card).getByRole('group', { name: 'Calculator result' })).toHaveTextContent(
      'At 4% you would capture the full $2,600 match',
    );
    expect(within(card).getByText('Saved v1 · Oct 17')).toBeInTheDocument();

    const fund = screen.getByRole('region', { name: 'Emergency fund' });
    expect(within(fund).getByText('Saved v1 · Oct 17')).toBeInTheDocument();
    expect(
      within(fund).getByRole('group', { name: 'Your emergency fund goal' }),
    ).toBeInTheDocument();
    const health = screen.getByRole('region', { name: 'Health plan' });
    expect(within(health).getByText('Saved v1 · Oct 17')).toBeInTheDocument();
    expect(
      within(health).getByRole('table', { name: 'Expected yearly cost by plan' }),
    ).toBeInTheDocument();

    const w4 = screen.getByRole('region', { name: 'W-4, federal only' });
    expect(within(w4).getByText('Saved v1 · Oct 17')).toBeInTheDocument();
    expect(within(w4).getByRole('group', { name: 'From your decisions' })).toHaveTextContent(
      '$62.50, Gold PPO',
    );
    expect(within(w4).getByRole('group', { name: 'Calculator result' })).toHaveTextContent(
      'A $0.08 refund at tax time',
    );
    expect(w4).toHaveTextContent(
      'Give your employer your updated Form W-4 is on your calendar for Oct 31, 2026.',
    );

    expect(screen.getByText(/of 4 saved/)).toHaveTextContent('4 of 4 saved');
    expect(screen.getByRole('link', { name: 'Decisions' })).toHaveAttribute('aria-current', 'page');
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(requests).toEqual([]);
  });

  it('renders the verified explanation, with no requests', async () => {
    const requests = countRequests();
    render(<SampleScreen screen="why" />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Why contribute 4% to your 401(k)' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Verified against calculator')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'What happens next' })).toHaveTextContent(
      'Oct 31, 2026',
    );
    expect(requests).toEqual([]);
  });

  it('renders the index of saved decisions, with no requests', async () => {
    const requests = countRequests();
    render(<SampleScreen screen="why-index" />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Why each decision' }),
    ).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Saved decisions' });
    expect(within(list).getByRole('link', { name: '401(k) match' })).toBeInTheDocument();
    expect(list).toHaveTextContent('v1 · Saved Oct 17');
    expect(screen.getByRole('link', { name: 'Why this decision' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(requests).toEqual([]);
  });

  it('renders the fallback, with no requests', async () => {
    const requests = countRequests();
    render(<SampleScreen screen="why-fallback" />);
    expect(await screen.findByText('Could not verify the explanation')).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: '401(k) match calculator result' }),
    ).toBeInTheDocument();
    expect(requests).toEqual([]);
  });

  it.each([
    ['confirm-extracting', /Reading pay stub/],
    ['confirm-failed', /This file could not be opened\./],
    ['confirm-confirmed', /This pay stub is confirmed\./],
  ] as const)(
    'renders the Confirm screen in its %s state, with no requests',
    async (name, text) => {
      const requests = countRequests();
      render(<SampleScreen screen={name} />);
      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(requests).toEqual([]);
    },
  );

  it('never polls the API for the document still being read', async () => {
    const requests = countRequests();
    render(<SampleScreen screen="confirm-extracting" />);
    expect(await screen.findByText(/Reading pay stub/)).toBeInTheDocument();
    // useDocument re-reads an extracting document every JOB_POLL_MS; the sample has no API.
    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS * 3));
    expect(requests).toEqual([]);
  });

  it('renders the account menu in the header for the account sample, with no requests', async () => {
    const requests = countRequests();
    render(<SampleScreen screen="account" />);
    const menu = screen.getByRole('button', { name: 'J. Rivera' });
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    expect(await screen.findByRole('group', { name: 'Chase Total Checking' })).toBeInTheDocument();
    expect(requests).toEqual([]);
  });
});

describe('seededClient', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['link', 'confirm-benefits', 'decisions', 'why', 'why-fallback', 'why-index'] as const)(
    'seeds every %s query at the sample time without reading the clock',
    (name) => {
      // It runs while the page renders: next dev prerenders the route to
      // validate it, and reports a Date.now() there as an unstable value.
      const now = vi.spyOn(Date, 'now');
      const client = seededClient(name);
      expect(now).not.toHaveBeenCalled();
      const queries = client.getQueryCache().getAll();
      expect(queries.length).toBeGreaterThan(5);
      for (const query of queries) {
        expect(query.state.dataUpdatedAt, JSON.stringify(query.queryKey)).toBe(
          Date.parse(SAMPLE_NOW),
        );
      }
    },
  );

  it("serves the calculator's result without asking the clock whether it is stale", () => {
    // useCalc keeps results fresh with staleTime Infinity, which compares the
    // data's age with Date.now(); on the 'static' sample client it is static too.
    const client = seededClient('decisions');
    const now = vi.spyOn(Date, 'now');
    const { result } = renderHook(() => useCalc('/calc/401k-match', sampleK401Inputs(4)), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    expect(result.current.data).toEqual(sampleK401(4).result);
    expect(result.current.isCurrent).toBe(true);
    expect(now).not.toHaveBeenCalled();
  });

  it('serves reads without asking the clock whether the data is stale', () => {
    // A numeric staleTime, even Infinity, makes every useQuery render compare
    // the data's age with Date.now().
    const client = seededClient();
    const now = vi.spyOn(Date, 'now');
    const { result } = renderHook(() => useAccounts(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    expect(result.current.data).toHaveLength(sampleAccounts.length);
    expect(now).not.toHaveBeenCalled();
  });
});
