import { delay, http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  confirmedDocument,
  samplePayStub,
  sampleBenefitsDocument,
  sampleDocument,
  stub01PayStub,
} from '@/test/fixtures/documents';
import { db, emptyDocuments } from '@/test/msw/db';
import { apiUrl } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { act, renderWithProviders, screen, waitFor, within } from '@/test/render';
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
    expect(
      await screen.findByRole('heading', { level: 1, name: 'No pay stub to check yet' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Add a pay stub/ })).toHaveAttribute(
      'href',
      '/setup/link',
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('says the pay stub is done, with nothing to check, when the only one is confirmed', async () => {
    db.documents = [sampleDocument({ status: 'confirmed' })];
    db.payStubs = [samplePayStub()];
    renderWithProviders(<ConfirmIndexScreen />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your pay stub is confirmed' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Check what we read/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Continue to spending/ })).toHaveAttribute(
      'href',
      '/setup/spending',
    );
  });

  it('shows the stub the plan uses, the newest, with its amounts and a link to add a newer one (issue 263)', async () => {
    const older = '4d000000-0000-4000-8000-000000000a10';
    db.documents = [confirmedDocument(), confirmedDocument({ id: older, pay_date: '2026-04-10' })];
    // GET /pay-stubs lists the newest pay date first: that is the plan's stub.
    db.payStubs = [samplePayStub(), stub01PayStub({ document_id: older })];
    renderWithProviders(<ConfirmIndexScreen />);
    await screen.findByRole('heading', { level: 1, name: 'Your pay stub is confirmed' });
    expect(
      screen.getByText(/Your plan uses this pay stub: Acme Corp, paid Oct 15, 2026\./),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'add your newest pay stub on the first step' }),
    ).toHaveAttribute('href', '/setup/link');

    const values = screen.getByRole('region', { name: 'The pay stub your plan uses' });
    const value = (label: string) =>
      within(values).getByText(label, { selector: 'dt' }).nextElementSibling;
    expect(value('Employer')).toHaveTextContent('Acme Corp');
    expect(value('Pay date')).toHaveTextContent('Oct 15, 2026');
    expect(value('Gross pay')).toHaveTextContent('$2,708.33');
    expect(value('Net pay')).toHaveTextContent('$1,996.04');
    expect(within(values).queryByRole('button')).toBeNull();
    expect(screen.queryByText('Apr 10, 2026')).not.toBeInTheDocument();
  });

  it('waits for the confirmed pay stubs before saying none is waiting (issue 196)', async () => {
    db.documents = [sampleDocument({ status: 'confirmed' })];
    server.use(
      http.get(apiUrl('/pay-stubs'), async () => {
        await delay('infinite');
      }),
    );
    renderWithProviders(<ConfirmIndexScreen />);
    expect(await screen.findByText('Finding your pay stub')).toBeInTheDocument();
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(screen.queryByText(/No pay stub to check yet/)).not.toBeInTheDocument();
    expect(screen.getByText('Finding your pay stub')).toBeInTheDocument();
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
