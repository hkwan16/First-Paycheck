import { delay, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BENEFITS_DOC_ID,
  confirmedDocument,
  sampleBenefitsDocument,
  sampleDocument,
} from '@/test/fixtures/documents';
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

  it('names a confirmed document by what was confirmed and links to its values (issue 243)', async () => {
    db.documents = [
      confirmedDocument({ id: 'acme' }),
      confirmedDocument({
        id: 'birch',
        employer_name: 'Birch Lane Clinic',
        pay_date: '2026-09-25',
      }),
      confirmedDocument({
        ...sampleBenefitsDocument,
        status: 'confirmed',
        employer_name: null,
        pay_date: null,
        plan_names: ['Bronze HSA', 'Gold PPO', 'Saver HDHP'],
      }),
    ];
    renderWithProviders(<DocumentsCard />);
    const acme = await within(card()).findByRole('group', {
      name: 'Pay stub · Acme Corp, paid Oct 15, 2026',
    });
    const birch = within(card()).getByRole('group', {
      name: 'Pay stub · Birch Lane Clinic, paid Sep 25, 2026',
    });
    const benefits = within(card()).getByRole('group', {
      name: 'Benefits summary · Bronze HSA, Gold PPO and Saver HDHP',
    });
    expect(within(acme).getByRole('link', { name: 'View pay stub' })).toHaveAttribute(
      'href',
      '/setup/confirm/acme',
    );
    expect(within(birch).getByRole('link', { name: 'View pay stub' })).toHaveAttribute(
      'href',
      '/setup/confirm/birch',
    );
    expect(within(benefits).getByRole('link', { name: 'View benefits summary' })).toHaveAttribute(
      'href',
      `/setup/confirm/${BENEFITS_DOC_ID}`,
    );
  });

  it('keeps a document nothing was confirmed from named by its type, with no View', async () => {
    db.documents = [sampleDocument()];
    renderWithProviders(<DocumentsCard />);
    const row = await within(card()).findByRole('group', { name: 'Pay stub' });
    expect(within(row).queryByRole('link', { name: /^View/ })).toBeNull();
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
