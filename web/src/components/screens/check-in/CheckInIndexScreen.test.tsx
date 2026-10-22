import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { NOVEMBER_ID, OCTOBER_ID } from '@/test/fixtures/checkins';
import { checkinDb } from '@/test/msw/checkin-handlers';
import { apiUrl } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderWithProviders as render, screen, within } from '@/test/render';
import { CheckInIndexScreen } from './CheckInIndexScreen';

describe('CheckInIndexScreen', () => {
  it('lists check-ins newest first with their finding and handled counts', async () => {
    render(<CheckInIndexScreen />);
    expect(screen.getByRole('heading', { level: 1, name: 'Monthly check-ins' })).toBeVisible();
    const list = await screen.findByRole('list', { name: 'Check-ins' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);

    expect(within(items[0]!).getByRole('link', { name: 'November 2026' })).toHaveAttribute(
      'href',
      `/check-in/${NOVEMBER_ID}`,
    );
    expect(items[0]).toHaveTextContent('9 findings');
    expect(items[0]).toHaveTextContent('0 of 9 handled');
    expect(items[0]).toHaveTextContent('Open');

    expect(within(items[1]!).getByRole('link', { name: 'October 2026' })).toHaveAttribute(
      'href',
      `/check-in/${OCTOBER_ID}`,
    );
    expect(items[1]).toHaveTextContent('2 findings');
    expect(items[1]).toHaveTextContent('2 of 2 handled');
    expect(items[1]).toHaveTextContent('Completed Oct 20, 2026');
  });

  it('explains when the first check-in will come', async () => {
    checkinDb.checkIns = [];
    render(<CheckInIndexScreen />);
    expect(await screen.findByText(/No check-in yet\./)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Check-ins' })).toBeNull();
  });

  it('says when the list could not load', async () => {
    server.use(
      http.get(apiUrl('/check-ins'), () =>
        HttpResponse.json(
          { error: { code: 'internal_error', message: 'Something went wrong.' } },
          { status: 500 },
        ),
      ),
    );
    render(<CheckInIndexScreen />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
  });
});
