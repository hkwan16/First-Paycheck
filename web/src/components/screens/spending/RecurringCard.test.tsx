import { delay, http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { sampleRecurring } from '@/test/fixtures/cashflow';
import { apiUrl } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { spendingDb } from '@/test/msw/spending-handlers';
import { renderWithProviders, screen, waitFor, within } from '@/test/render';
import { RecurringCard } from './RecurringCard';

const card = () => screen.getByRole('region', { name: 'Recurring charges' });
const row = (name: string) => within(card()).getByRole('listitem', { name });

async function renderCard() {
  const rendered = renderWithProviders(<RecurringCard />);
  await within(card()).findByRole('listitem', { name: 'Spotify' });
  return rendered;
}

/** PATCH bodies sent to `/recurring/{id}`. */
function patches() {
  const bodies: unknown[] = [];
  server.events.on('request:start', async ({ request }) => {
    if (request.method === 'PATCH') bodies.push(await request.clone().json());
  });
  return bodies;
}

/** Answer PATCHes slowly, so the optimistic state can be seen first. */
function slowPatches() {
  server.use(
    http.patch(apiUrl('/recurring/:id'), async ({ params, request }) => {
      await delay(200);
      const charge = spendingDb.recurring.find((c) => c.id === params.id)!;
      const body = (await request.json()) as Record<string, string | null>;
      if (typeof body.merchant_clean === 'string') body.merchant_clean = body.merchant_clean.trim();
      Object.assign(charge, body);
      return HttpResponse.json(charge);
    }),
  );
}

afterEach(() => server.events.removeAllListeners());

describe('RecurringCard', () => {
  it('lists each charge with its cadence, typical amount and what the detector says', async () => {
    await renderCard();
    expect(
      within(card())
        .getAllByRole('listitem')
        .map((li) => li.getAttribute('aria-label')),
    ).toEqual(['Hulu', 'Lemonade Renters', 'Parkline Apartments', 'Spotify', 'Verizon Wireless']);
    expect(row('Spotify')).toHaveTextContent('Monthly · last Oct 5');
    expect(row('Spotify')).toHaveTextContent('$11.99');
    expect(row('Spotify')).toHaveTextContent('Active');
    expect(row('Lemonade Renters')).toHaveTextContent('New');
    expect(row('Verizon Wireless')).toHaveTextContent('Price changed');
    expect(row('Hulu')).toHaveTextContent('Stopped');
    expect(within(card()).getByText('5 found')).toBeInTheDocument();
  });

  it('marks a charge not recurring at once, then offers to undo it', async () => {
    slowPatches();
    const sent = patches();
    const { user } = await renderCard();
    await user.click(within(row('Spotify')).getByRole('button', { name: 'Not recurring' }));

    expect(within(row('Spotify')).getByText('Not recurring')).toBeInTheDocument();
    const undo = within(row('Spotify')).getByRole('button', { name: 'Undo' });
    await waitFor(() => expect(sent).toEqual([{ user_status: 'ignored' }]));

    await user.click(undo);
    await waitFor(() => expect(sent).toEqual([{ user_status: 'ignored' }, { user_status: null }]));
    expect(
      await within(row('Spotify')).findByRole('button', { name: 'Not recurring' }),
    ).toBeInTheDocument();
  });

  it('says only what the person decided once they mark a charge, and the detector again on Undo', async () => {
    // Issue 182: Spotify kept "Active" beside "Not recurring".
    const { user } = await renderCard();
    await user.click(within(row('Spotify')).getByRole('button', { name: 'Not recurring' }));

    expect(within(row('Spotify')).getByText('Not recurring')).toBeInTheDocument();
    expect(within(row('Spotify')).queryByText('Active')).not.toBeInTheDocument();
    await waitFor(() => expect(spendingDb.recurring[3]!.user_status).toBe('ignored'));
    expect(within(row('Spotify')).queryByText('Active')).not.toBeInTheDocument();

    await user.click(within(row('Spotify')).getByRole('button', { name: 'Undo' }));
    expect(await within(row('Spotify')).findByText('Active')).toBeInTheDocument();
    // The only "Not recurring" left is the button that marks it again.
    expect(within(row('Spotify')).getByText('Not recurring').closest('button')).not.toBeNull();
  });

  it('renames a charge in place, showing the new name before the server answers', async () => {
    slowPatches();
    const sent = patches();
    const { user } = await renderCard();
    await user.click(within(row('Spotify')).getByRole('button', { name: 'Rename' }));
    const input = within(card()).getByRole('textbox', { name: 'New name for Spotify' });
    expect(input).toHaveValue('Spotify');
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, ' Spotify Family {Enter}');

    expect(row('Spotify Family')).toBeInTheDocument();
    await waitFor(() => expect(sent).toEqual([{ merchant_clean: 'Spotify Family' }]));
    expect(within(row('Spotify Family')).getByRole('button', { name: 'Rename' })).toHaveFocus();
  });

  it('refuses an empty name without asking the server', async () => {
    const sent = patches();
    const { user } = await renderCard();
    await user.click(within(row('Hulu')).getByRole('button', { name: 'Rename' }));
    const input = within(card()).getByRole('textbox', { name: 'New name for Hulu' });
    await user.clear(input);
    await user.click(within(card()).getByRole('button', { name: 'Save' }));
    expect(input).toHaveAccessibleDescription('Enter a name.');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(sent).toEqual([]);
  });

  it('cancels a rename with Escape, keeping the old name', async () => {
    const { user } = await renderCard();
    await user.click(within(row('Hulu')).getByRole('button', { name: 'Rename' }));
    await user.type(
      within(card()).getByRole('textbox', { name: 'New name for Hulu' }),
      'x{Escape}',
    );
    expect(within(card()).queryByRole('textbox')).not.toBeInTheDocument();
    expect(row('Hulu')).toBeInTheDocument();
    expect(within(row('Hulu')).getByRole('button', { name: 'Rename' })).toHaveFocus();
  });

  it('puts the charge back and says so when the server refuses', async () => {
    server.use(
      http.patch(apiUrl('/recurring/:id'), async () => {
        await delay(100);
        return HttpResponse.json(
          { error: { code: 'not_found', message: 'Recurring charge not found' } },
          { status: 404 },
        );
      }),
    );
    const { user } = await renderCard();
    await user.click(
      within(row('Verizon Wireless')).getByRole('button', { name: 'Not recurring' }),
    );
    expect(within(row('Verizon Wireless')).getByText('Not recurring')).toBeInTheDocument();

    const alert = await within(card()).findByRole('alert');
    expect(alert).toHaveTextContent(
      'Could not save Verizon Wireless. It is back to how it was. Recurring charge not found',
    );
    expect(
      within(row('Verizon Wireless')).getByRole('button', { name: 'Not recurring' }),
    ).toBeInTheDocument();
  });

  it('says what will show up here when nothing recurs yet', async () => {
    spendingDb.recurring = [];
    renderWithProviders(<RecurringCard />);
    expect(
      await within(card()).findByText(
        'Nothing recurring yet. A charge shows up here once it repeats on a weekly, monthly or yearly rhythm.',
      ),
    ).toBeInTheDocument();
  });

  it('offers a retry when the list cannot be read', async () => {
    server.use(
      http.get(apiUrl('/recurring'), () =>
        HttpResponse.json({ error: { code: 'x', message: 'Database is busy' } }, { status: 503 }),
      ),
    );
    const { user } = renderWithProviders(<RecurringCard />);
    const alert = await within(card()).findByRole('alert');
    expect(alert).toHaveTextContent('Could not load your recurring charges. Database is busy');
    server.resetHandlers();
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await within(card()).findByRole('listitem', { name: 'Hulu' })).toBeInTheDocument();
  });

  it('keeps an ignored charge listed, muted, so it can be restored', async () => {
    spendingDb.recurring[0] = { ...sampleRecurring[0]!, user_status: 'ignored' };
    await renderCard();
    expect(within(row('Hulu')).getByText('Not recurring')).toBeInTheDocument();
    expect(within(row('Hulu')).queryByText('Stopped')).not.toBeInTheDocument();
    expect(within(row('Hulu')).getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });
});
