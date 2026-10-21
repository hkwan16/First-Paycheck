import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Pending from '@/lib/api/pending';
import type { DocumentSummary } from '@/lib/api/pending';
import { SAMPLE_NOW } from '@/test/fixtures/sample';
import { DocumentsCard } from './DocumentsCard';

// GET /docs does not exist yet; stand in for the rows it will return.
const documents = vi.hoisted(() => ({ current: undefined as DocumentSummary[] | undefined }));
vi.mock('@/lib/api/pending', async (importOriginal) => ({
  ...(await importOriginal<typeof Pending>()),
  useDocuments: () => documents.current,
}));

const stub: DocumentSummary = {
  id: 'doc-1',
  kind: 'pay_stub',
  filename: 'acme-paystub-2026-10-15.pdf',
  page_count: 1,
  redaction_count: 2,
  status: 'extracted',
  created_at: '2026-10-17T15:58:00Z',
};

describe('DocumentsCard', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date(SAMPLE_NOW) }));
  afterEach(() => {
    vi.useRealTimers();
    documents.current = undefined;
  });

  it('lists documents with pages, upload time and the redaction count', () => {
    documents.current = [
      stub,
      {
        ...stub,
        id: 'doc-2',
        kind: 'benefits',
        filename: 'benefits.pdf',
        page_count: 14,
        redaction_count: 0,
      },
    ];
    render(<DocumentsCard />);
    const card = screen.getByRole('region', { name: 'Documents' });
    expect(card).toHaveTextContent('Pay stub');
    expect(card).toHaveTextContent('acme-paystub-2026-10-15.pdf · 1 page · uploaded 2 minutes ago');
    expect(within(card).getByText('2 items redacted')).toHaveClass('bg-coral-tint');
    expect(card).toHaveTextContent('benefits.pdf · 14 pages');
    expect(within(card).getByText('0 items redacted')).toHaveClass('bg-fill');
    expect(within(card).queryByText(/No documents yet/)).not.toBeInTheDocument();
  });

  it('shows the empty state without documents', () => {
    render(<DocumentsCard />);
    expect(screen.getByText(/No documents yet/)).toBeInTheDocument();
  });
});
