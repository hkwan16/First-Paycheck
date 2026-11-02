import { delay, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleBenefitsDocument, sampleDocument } from '@/test/fixtures/documents';
import { SAMPLE_NOW } from '@/test/fixtures/sample';
import { db, emptyDocuments } from '@/test/msw/db';
import { apiUrl } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderWithProviders, screen, within } from '@/test/render';
import { DocumentsCard } from './DocumentsCard';

const card = () => screen.getByRole('region', { name: 'Documents' });
const rows = () => within(card()).getAllByRole('group', { name: /^(Pay stub|Benefits summary)/ });

describe('DocumentsCard', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(SAMPLE_NOW) }));
  afterEach(() => vi.useRealTimers());

  it('lists documents with pages, upload time and how many numbers were hidden', async () => {
    db.documents = [sampleDocument(), sampleBenefitsDocument];
    renderWithProviders(<DocumentsCard />);
    expect(await within(card()).findByText('2 numbers hidden')).toHaveClass('bg-coral-tint');
    expect(card()).toHaveTextContent('Pay stub');
    expect(card()).toHaveTextContent('1 page · uploaded 2 minutes ago');
    expect(card()).toHaveTextContent('14 pages · uploaded 3 minutes ago');
    expect(within(card()).getByText('No numbers hidden')).toHaveClass('bg-fill');
    expect(within(card()).queryByText(/No documents yet/)).not.toBeInTheDocument();
  });

  it('shows the empty state without documents', async () => {
    emptyDocuments();
    renderWithProviders(<DocumentsCard />);
    expect(await screen.findByText(/No documents yet/)).toBeInTheDocument();
  });

  it('shows a loading state, never the empty state, while the list loads (issue 196)', async () => {
    // A cold API (Render waking up) answers after tens of seconds.
    server.use(
      http.get(apiUrl('/docs'), async () => {
        await delay('infinite');
      }),
    );
    renderWithProviders(<DocumentsCard />);
    const loading = await within(card()).findByText('Loading your documents');
    expect(loading.closest('[aria-busy]')).toHaveAttribute('aria-busy', 'true');
    expect(within(card()).queryByText(/No documents yet/)).not.toBeInTheDocument();
  });

  it('badges only the copy that counts as Confirmed (issue 199)', async () => {
    const confirmed = {
      status: 'confirmed' as const,
      confirmed_at: SAMPLE_NOW,
      deleted_at: SAMPLE_NOW,
    };
    db.documents = [
      sampleDocument({ id: 'newer', ...confirmed }),
      sampleDocument({ id: 'older', ...confirmed, superseded: true }),
    ];
    renderWithProviders(<DocumentsCard />);
    await within(card()).findAllByRole('group', { name: /^Pay stub/ });
    const [newer, older] = rows();
    expect(within(newer!).getByText('Confirmed')).toBeInTheDocument();
    expect(within(older!).queryByText('Confirmed')).not.toBeInTheDocument();
    expect(within(older!).getByText('Replaced by a newer copy')).toBeInTheDocument();
    expect(older).toHaveTextContent('You confirmed this paycheck again, so the newer copy counts.');
    // Nothing is left to do with it, so it offers no Replace.
    expect(within(older!).queryByRole('button', { name: 'Replace pay stub' })).toBeNull();
    expect(within(newer!).getByRole('button', { name: 'Replace pay stub' })).toBeInTheDocument();
  });

  it('puts the upload control above the list, so a new upload lands below it (issue 208)', async () => {
    db.documents = [sampleDocument(), sampleBenefitsDocument];
    renderWithProviders(<DocumentsCard />);
    await within(card()).findAllByRole('group', { name: /^Pay stub/ });
    const upload = within(card()).getByLabelText(/^Add another document/);
    const [first] = rows();
    expect(upload.compareDocumentPosition(first!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
