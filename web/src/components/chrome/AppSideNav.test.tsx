import { describe, expect, it, vi } from 'vitest';
import type * as Pending from '@/lib/api/pending';
import type { DocumentSummary } from '@/lib/api/pending';
import { renderWithProviders as render, screen } from '@/test/render';
import { AppSideNav } from './AppSideNav';

const pathname = vi.hoisted(() => ({ current: '/setup/spending' }));
vi.mock('next/navigation', () => ({ usePathname: () => pathname.current }));

// GET /docs does not exist yet; stand in for it to show the marks follow data.
const documents = vi.hoisted(() => ({ current: undefined as DocumentSummary[] | undefined }));
vi.mock('@/lib/api/pending', async (importOriginal) => ({
  ...(await importOriginal<typeof Pending>()),
  useDocuments: () => documents.current,
}));

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
    documents.current = [
      {
        id: 'doc-1',
        kind: 'pay_stub',
        filename: 'acme-paystub.pdf',
        page_count: 1,
        redaction_count: 2,
        status: 'extracted',
        created_at: '2026-10-17T15:58:00Z',
      },
    ];
    render(<AppSideNav />);
    // Accounts (from GET /accounts) and a document: step 1 is done.
    expect(
      await screen.findByRole('link', { name: 'Accounts and documents, done' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Spending map' })).toBeInTheDocument();
    documents.current = undefined;
  });

  it('marks nothing done before the data arrives', () => {
    pathname.current = '/setup/link';
    render(<AppSideNav />);
    expect(screen.getByRole('link', { name: 'Accounts and documents' })).toBeInTheDocument();
  });
});
