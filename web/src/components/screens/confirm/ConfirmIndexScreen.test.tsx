import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { samplePayStub, sampleBenefitsDocument, sampleDocument } from '@/test/fixtures/documents';
import { db, emptyDocuments } from '@/test/msw/db';
import { apiUrl } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderWithProviders, screen, waitFor } from '@/test/render';
import { ConfirmIndexScreen } from './ConfirmIndexScreen';

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

afterEach(() => router.replace.mockReset());

describe('ConfirmIndexScreen', () => {
  it('goes to the newest pay stub waiting for review', async () => {
    db.documents = [
      sampleBenefitsDocument,
      sampleDocument({ id: 'newest', status: 'manual_entry_required' }),
      sampleDocument({ id: 'older' }),
    ];
    renderWithProviders(<ConfirmIndexScreen />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/setup/confirm/newest'));
    expect(screen.getByText('Finding your pay stub')).toBeInTheDocument();
  });

  it('shows an empty state linking to Link when nothing waits for review', async () => {
    emptyDocuments();
    renderWithProviders(<ConfirmIndexScreen />);
    expect(await screen.findByText(/No pay stub is waiting for review/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Add a pay stub/ })).toHaveAttribute(
      'href',
      '/setup/link',
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('says the pay stub is done when the only one is confirmed', async () => {
    db.documents = [sampleDocument({ status: 'confirmed' })];
    db.payStubs = [samplePayStub()];
    renderWithProviders(<ConfirmIndexScreen />);
    expect(await screen.findByText(/Your pay stub is confirmed/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Continue to spending/ })).toHaveAttribute(
      'href',
      '/setup/spending',
    );
  });

  it('reports a failed read of the documents', async () => {
    server.use(
      http.get(apiUrl('/docs'), () =>
        HttpResponse.json({ error: { code: 'x', message: 'Database is busy' } }, { status: 503 }),
      ),
    );
    renderWithProviders(<ConfirmIndexScreen />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load your documents. Database is busy',
    );
  });
});
