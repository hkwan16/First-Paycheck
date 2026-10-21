import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markPageHydrated, resetPageHydration } from '@/lib/page-hydration';
import { samplePayStub } from '@/test/fixtures/documents';
import { db } from '@/test/msw/db';
import { server } from '@/test/msw/server';
import { act, renderWithProviders as render, screen, waitFor } from '@/test/render';
import { AppSideNav } from './AppSideNav';

const pathname = vi.hoisted(() => ({ current: '/setup/spending' }));
vi.mock('next/navigation', () => ({ usePathname: () => pathname.current }));

describe('AppSideNav', () => {
  beforeEach(() => markPageHydrated());
  afterEach(() => {
    resetPageHydration();
    server.events.removeAllListeners();
  });

  it('marks the screen for the current path', () => {
    pathname.current = '/setup/spending';
    render(<AppSideNav />);
    expect(screen.getByRole('link', { name: 'Spending map' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('passes done marks through', () => {
    pathname.current = '/plan';
    render(<AppSideNav done={{ link: true }} />);
    expect(screen.getByRole('link', { name: 'Accounts and documents, done' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Plan and calendar' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('derives done marks from API data', async () => {
    pathname.current = '/setup/link';
    db.payStubs = [samplePayStub()];
    render(<AppSideNav />);
    // Accounts (GET /accounts) and a document (GET /docs): step 1 is done.
    expect(
      await screen.findByRole('link', { name: 'Accounts and documents, done' }),
    ).toBeInTheDocument();
    // A confirmed pay stub (GET /pay-stubs): step 2 is done.
    await waitFor(() =>
      expect(screen.getByText('Confirm pay stub').closest('li')).toHaveTextContent(
        'Confirm pay stub, done',
      ),
    );
    // Transactions, and a summary (GET /spending/summary) with none uncategorized: step 3 is done.
    expect(await screen.findByRole('link', { name: 'Spending map, done' })).toBeInTheDocument();
  });

  it('marks nothing done before the data arrives', () => {
    pathname.current = '/setup/link';
    render(<AppSideNav />);
    expect(screen.getByRole('link', { name: 'Accounts and documents' })).toBeInTheDocument();
  });

  it('reads nothing from the API until the page below it has hydrated', async () => {
    // The layout hydrates before the page. Had the nav fetched /accounts first,
    // the page would hydrate with that data while its server HTML showed a
    // skeleton: a hydration mismatch (found by e2e/alpha.spec.ts).
    resetPageHydration();
    const requests: string[] = [];
    server.events.on('request:start', ({ request }) => {
      requests.push(new URL(request.url).pathname);
    });
    pathname.current = '/setup/link';
    const { queryClient } = render(<AppSideNav />);
    expect(screen.getByRole('link', { name: 'Accounts and documents' })).toBeInTheDocument();
    // Queries register while rendering, so an empty cache means no read started.
    expect(queryClient.getQueryCache().getAll()).toEqual([]);

    act(() => markPageHydrated());
    expect(
      await screen.findByRole('link', { name: 'Accounts and documents, done' }),
    ).toBeInTheDocument();
    expect(requests).toContain('/accounts');
  });
});
