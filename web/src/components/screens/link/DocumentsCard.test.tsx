import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleBenefitsDocument, sampleDocument } from '@/test/fixtures/documents';
import { SAMPLE_NOW } from '@/test/fixtures/sample';
import { db, emptyDocuments } from '@/test/msw/db';
import { renderWithProviders, screen, within } from '@/test/render';
import { DocumentsCard } from './DocumentsCard';

describe('DocumentsCard', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(SAMPLE_NOW) }));
  afterEach(() => vi.useRealTimers());

  it('lists documents with pages, upload time and the redaction count', async () => {
    db.documents = [sampleDocument(), sampleBenefitsDocument];
    renderWithProviders(<DocumentsCard />);
    const card = screen.getByRole('region', { name: 'Documents' });
    expect(await within(card).findByText('2 items redacted')).toHaveClass('bg-coral-tint');
    expect(card).toHaveTextContent('Pay stub');
    expect(card).toHaveTextContent('1 page · uploaded 2 minutes ago');
    expect(card).toHaveTextContent('14 pages · uploaded 3 minutes ago');
    expect(within(card).getByText('0 items redacted')).toHaveClass('bg-fill');
    expect(within(card).queryByText(/No documents yet/)).not.toBeInTheDocument();
  });

  it('shows the empty state without documents', async () => {
    emptyDocuments();
    renderWithProviders(<DocumentsCard />);
    expect(await screen.findByText(/No documents yet/)).toBeInTheDocument();
  });
});
