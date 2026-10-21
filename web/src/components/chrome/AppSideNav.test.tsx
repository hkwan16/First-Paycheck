import { describe, expect, it, vi } from 'vitest';
import { samplePayStub } from '@/test/fixtures/documents';
import { db } from '@/test/msw/db';
import { renderWithProviders as render, screen, waitFor } from '@/test/render';
import { AppSideNav } from './AppSideNav';

const pathname = vi.hoisted(() => ({ current: '/setup/spending' }));
vi.mock('next/navigation', () => ({ usePathname: () => pathname.current }));

describe('AppSideNav', () => {
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
});
