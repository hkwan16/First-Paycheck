import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_POLL_MS, usePayStubs } from '@/lib/api/hooks';
import {
  BENEFITS_DOC_ID,
  confirmedDocument,
  manualEntryProposal,
  PAY_STUB_DOC_ID,
  sampleBenefitsDocument,
  sampleDocument,
  samplePayStub,
  sampleProposal,
  sampleValues,
} from '@/test/fixtures/documents';
import { SAMPLE_NOW } from '@/test/fixtures/sample';
import { sampleBenefitsProposal, sampleBenefitsValues } from '@/test/fixtures/planning';
import { db } from '@/test/msw/db';
import { apiUrl } from '@/test/msw/handlers';
import { benefitsConfirmed, benefitsWaiting, planningDb } from '@/test/msw/planning-handlers';
import { server } from '@/test/msw/server';
import { act, fireEvent, renderWithProviders, screen, waitFor, within } from '@/test/render';
import { ConfirmScreen } from './ConfirmScreen';

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

function confirmBodies() {
  const bodies: unknown[] = [];
  server.events.on('request:start', async ({ request }) => {
    if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/confirm')) {
      bodies.push(await request.clone().json());
    }
  });
  return bodies;
}

function renderConfirm(documentId = PAY_STUB_DOC_ID) {
  return renderWithProviders(<ConfirmScreen documentId={documentId} />, {
    advanceTimers: vi.advanceTimersByTime,
  });
}

const FIELDS = /^(What we read|Pay stub details)$/;
const fieldsCard = () => screen.getByRole('region', { name: FIELDS });
const sourcePane = () => screen.getByRole('complementary', { name: 'Your pay stub' });
const row = (label: string) => within(fieldsCard()).getByRole('group', { name: label });
const continueButton = () => screen.getByRole('button', { name: /Confirm and continue/ });
const highlighted = () =>
  within(sourcePane())
    .getAllByRole('listitem')
    .filter((li) => li.getAttribute('aria-current') === 'true');

async function renderLoaded(documentId = PAY_STUB_DOC_ID) {
  const rendered = renderConfirm(documentId);
  await screen.findByRole('region', { name: FIELDS });
  return rendered;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(SAMPLE_NOW) });
  router.push.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  server.events.removeAllListeners();
});

describe('ConfirmScreen review', () => {
  it('lists every proposed field with its value, note and confidence', async () => {
    await renderLoaded();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Check what we read from your pay stub',
    );
    expect(within(fieldsCard()).getAllByRole('group')).toHaveLength(14);
    expect(fieldsCard()).toHaveTextContent('0 of 14 confirmed');

    expect(row('Gross pay')).toHaveTextContent('$2,708.33');
    expect(within(row('Gross pay')).getByText('Read clearly')).toBeInTheDocument();
    expect(within(row('401(k) contribution')).getByText('Check this')).toBeInTheDocument();
    expect(row('Pay date')).toHaveTextContent('Oct 15, 2026');
    expect(row('Pay frequency')).toHaveTextContent('Twice a month');
    expect(row('Other deductions')).toHaveTextContent('From CA SDI and DENTAL/VIS');
    expect(within(row('Other deductions')).getByText('Added up')).toBeInTheDocument();

    const bar = within(fieldsCard()).getByRole('progressbar', { name: 'Fields confirmed' });
    expect(bar).toHaveAttribute('aria-valuenow', '0');
    expect(within(fieldsCard()).getByText('The math checks out.')).toBeInTheDocument();
    expect(continueButton()).toBeDisabled();
    expect(screen.getByText('14 left to confirm')).toBeInTheDocument();
  });

  it('shows the source, private numbers hidden, with the selected field highlighted', async () => {
    const { user } = await renderLoaded();
    const pane = sourcePane();
    expect(within(pane).getByText('2 numbers hidden')).toBeInTheDocument();
    expect(within(pane).getAllByRole('img', { name: 'Hidden number' })).toHaveLength(2);
    expect(pane).not.toHaveTextContent('[REDACTED]');
    expect(highlighted()).toHaveLength(1);
    expect(highlighted()[0]).toHaveTextContent('GROSS PAY2,708.33');
    expect(pane).toHaveTextContent('Gross pay is highlighted.');

    await user.click(within(row('Net pay')).getByRole('button', { name: /^Net pay/ }));
    expect(highlighted()[0]).toHaveTextContent('NET PAY1,996.04');
    expect(pane).toHaveTextContent('Net pay is highlighted.');

    await user.click(within(row('Period end')).getByRole('button', { name: /^Period end/ }));
    expect(highlighted()).toHaveLength(0);
    expect(pane).toHaveTextContent('Period end is not on a line of its own.');
  });

  it('still goes to Spending when the confirmed document renders before the other reads return', async () => {
    // In the app the side nav also reads /docs and /pay-stubs, so confirming
    // refetches them too, and the document's own refetch can land first: the
    // screen switches to its "confirmed" view and unmounts the review while
    // /pay-stubs is still loading. The move to Spending must not depend on
    // the review staying on screen (found by the e2e specs against the API).
    let releasePayStubs: () => void = () => {};
    const payStubsHeld = new Promise<void>((resolve) => {
      releasePayStubs = resolve;
    });
    let confirmed = false;
    server.use(
      http.post(apiUrl('/docs/:id/confirm'), () => {
        confirmed = true;
        return undefined;
      }),
      http.get(apiUrl('/pay-stubs'), async () => {
        if (confirmed) await payStubsHeld;
        return undefined;
      }),
    );
    function PayStubsReader() {
      usePayStubs();
      return null;
    }
    const { user } = renderWithProviders(
      <>
        <ConfirmScreen documentId={PAY_STUB_DOC_ID} />
        <PayStubsReader />
      </>,
      { advanceTimers: vi.advanceTimersByTime },
    );
    await screen.findByRole('region', { name: FIELDS });
    await user.click(screen.getByRole('button', { name: 'Confirm all remaining' }));
    await user.click(continueButton());

    await screen.findByRole('heading', { level: 1, name: 'Your pay stub is confirmed' });
    releasePayStubs();
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/setup/spending'));
  });

  it('confirms one field at a time with a pressed toggle and moves the progress bar', async () => {
    const { user } = await renderLoaded();
    const confirm = within(row('Gross pay')).getByRole('button', { name: 'Confirm Gross pay' });
    expect(confirm).toHaveAttribute('aria-pressed', 'false');
    await user.click(confirm);
    const confirmed = within(row('Gross pay')).getByRole('button', { name: 'Confirmed Gross pay' });
    expect(confirmed).toHaveAttribute('aria-pressed', 'true');
    expect(fieldsCard()).toHaveTextContent('1 of 14 confirmed');
    expect(
      within(fieldsCard()).getByRole('progressbar', { name: 'Fields confirmed' }),
    ).toHaveAttribute('aria-valuenow', '7');
    await user.click(confirmed);
    expect(fieldsCard()).toHaveTextContent('0 of 14 confirmed');
  });

  it('confirm-all enables continue, which saves the values and goes to Spending', async () => {
    const bodies = confirmBodies();
    const { user, queryClient } = await renderLoaded();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await user.click(screen.getByRole('button', { name: 'Confirm all remaining' }));
    expect(fieldsCard()).toHaveTextContent('14 of 14 confirmed');
    expect(continueButton()).toBeEnabled();
    expect(screen.queryByText(/left to confirm/)).not.toBeInTheDocument();

    await user.click(continueButton());
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/setup/spending'));
    expect(bodies).toEqual([{ pay_stub: sampleValues }]);
    expect(db.payStubs).toHaveLength(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['get', '/pay-stubs'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['get', '/docs'] });
  });

  it('edits a field inline: Enter saves and confirms, and the gate follows the typing', async () => {
    const bodies = confirmBodies();
    const { user } = await renderLoaded();
    await user.click(within(row('Net pay')).getByRole('button', { name: 'Edit Net pay' }));
    const input = within(row('Net pay')).getByRole('textbox', { name: 'Net pay' });
    expect(input).toHaveFocus();
    expect(input).toHaveValue('1,996.04');

    await user.clear(input);
    await user.type(input, '1,996.06');
    const gate = within(fieldsCard()).getByText("These don't add up.").closest('div')!;
    expect(gate).toHaveTextContent(
      'Gross pay minus deductions is $0.02 away from net pay. Check each amount against your pay stub.',
    );

    await user.type(input, '{Enter}');
    expect(row('Net pay')).toHaveTextContent('$1,996.06');
    expect(within(row('Net pay')).getByRole('button', { name: 'Edit Net pay' })).toHaveFocus();
    expect(
      within(row('Net pay')).getByRole('button', { name: 'Confirmed Net pay' }),
    ).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'Confirm all remaining' }));
    expect(continueButton()).toBeDisabled();
    expect(screen.getByText('Fix the amounts to continue')).toBeInTheDocument();
    expect(bodies).toEqual([]);
  });

  it('says which amount is not an amount yet, never "$?", and why on save', async () => {
    const { user } = await renderLoaded();
    await user.click(within(row('Gross pay')).getByRole('button', { name: 'Edit Gross pay' }));
    const input = within(row('Gross pay')).getByRole('textbox', { name: 'Gross pay' });
    await user.clear(input);
    await user.type(input, '2,708.3x');
    expect(fieldsCard()).toHaveTextContent(
      "Can't check the math yet. Gross pay is not an amount yet.",
    );
    expect(fieldsCard()).not.toHaveTextContent('$?');
    await user.type(input, '{Enter}');
    expect(input).toHaveAccessibleDescription('Enter an amount, like 1,234.56');
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  describe('a deduction the stub does not print (issue 230)', () => {
    // stub-07 prints no 401(k) line, so its field comes back null.
    beforeEach(() => {
      const proposal = structuredClone(sampleProposal);
      const k401 = proposal.fields!.find((f) => f.key === 'retirement_contribution_cents')!;
      Object.assign(k401, {
        value: null,
        confidence: 0.97,
        note: 'Type it if the document shows it.',
      });
      db.proposals.set(PAY_STUB_DOC_ID, proposal);
    });

    it('is confirmed as none in one step and labeled as the person entry', async () => {
      const bodies = confirmBodies();
      const { user } = await renderLoaded();
      const k401 = () => row('401(k) contribution');
      expect(k401()).toHaveTextContent('Not found');
      expect(k401()).toHaveTextContent('If your stub has no such line, confirm none.');
      expect(within(k401()).queryByText('Read clearly')).not.toBeInTheDocument();
      expect(within(k401()).getByText('Check this')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Confirm all remaining' }));
      expect(fieldsCard()).toHaveTextContent(
        "Can't check the math yet. 401(k) contribution is missing. Confirm it as none if your stub has no such line.",
      );
      expect(fieldsCard()).not.toHaveTextContent('$?');

      await user.click(
        within(k401()).getByRole('button', { name: 'Confirm none for 401(k) contribution' }),
      );
      expect(k401()).toHaveTextContent('$0.00');
      expect(within(k401()).getByText('Your entry')).toBeInTheDocument();
      expect(k401()).not.toHaveTextContent('If your stub has no such line');
      expect(
        within(k401()).getByRole('button', { name: 'Confirmed 401(k) contribution' }),
      ).toHaveAttribute('aria-pressed', 'true');
      expect(within(fieldsCard()).getByText('The math checks out.')).toBeInTheDocument();

      await user.click(continueButton());
      await waitFor(() => expect(router.push).toHaveBeenCalledWith('/setup/spending'));
      expect(bodies).toEqual([{ pay_stub: { ...sampleValues, retirement_contribution_cents: 0 } }]);
    });

    it('takes an empty save of its editor as none, and says so in the editor', async () => {
      const { user } = await renderLoaded();
      await user.click(
        within(row('401(k) contribution')).getByRole('button', {
          name: 'Edit 401(k) contribution',
        }),
      );
      const input = within(row('401(k) contribution')).getByRole('textbox', {
        name: '401(k) contribution',
      });
      expect(input).toHaveFocus();
      expect(input).toHaveAccessibleDescription('Leave it empty if your stub has no such line.');
      await user.type(input, '{Enter}');
      expect(row('401(k) contribution')).toHaveTextContent('$0.00');
      expect(within(row('401(k) contribution')).getByText('Your entry')).toBeInTheDocument();
    });
  });

  describe('progress through the review (spec 005 rules 23c-23e, issue 229)', () => {
    it('survives a reload: what was entered and confirmed comes back', async () => {
      const first = await renderLoaded();
      const { user } = first;
      await user.click(within(row('Gross pay')).getByRole('button', { name: 'Edit Gross pay' }));
      const input = within(row('Gross pay')).getByRole('textbox', { name: 'Gross pay' });
      await user.clear(input);
      await user.type(input, '2,708.34{Enter}');
      await user.click(screen.getByRole('button', { name: 'Confirm all remaining' }));
      await user.click(within(row('Net pay')).getByRole('button', { name: 'Confirmed Net pay' }));
      expect(fieldsCard()).toHaveTextContent('13 of 14 confirmed · Saving your progress');
      await waitFor(() =>
        expect(fieldsCard()).toHaveTextContent('13 of 14 confirmed · Progress saved'),
      );
      await waitFor(() =>
        expect(db.reviews.get(PAY_STUB_DOC_ID)?.fields.filter((f) => f.confirmed)).toHaveLength(13),
      );
      first.unmount();

      // A reload: a new page, a new cache, the same API.
      await renderLoaded();
      expect(fieldsCard()).toHaveTextContent('13 of 14 confirmed');
      expect(row('Gross pay')).toHaveTextContent('$2,708.34');
      expect(within(row('Gross pay')).getByText('Your entry')).toBeInTheDocument();
      expect(
        within(row('Net pay')).getByRole('button', { name: 'Confirm Net pay' }),
      ).toHaveAttribute('aria-pressed', 'false');
    });

    it('says when progress could not be saved, and confirming still works', async () => {
      server.use(
        http.put(apiUrl('/docs/:id/review'), () =>
          HttpResponse.json({ error: { code: 'internal', message: 'x' } }, { status: 500 }),
        ),
      );
      const { user } = await renderLoaded();
      await user.click(screen.getByRole('button', { name: 'Confirm all remaining' }));
      expect(
        await within(fieldsCard()).findByText(
          'Your progress on this page could not be saved, so a reload would lose it.',
        ),
      ).toBeInTheDocument();
      await user.click(continueButton());
      await waitFor(() => expect(router.push).toHaveBeenCalledWith('/setup/spending'));
    });

    it('is not sent before the person changes anything', async () => {
      const puts: string[] = [];
      server.events.on('request:start', ({ request }) => {
        if (request.method === 'PUT') puts.push(new URL(request.url).pathname);
      });
      await renderLoaded();
      await act(() => vi.advanceTimersByTimeAsync(1_000));
      expect(puts).toEqual([]);
    });
  });

  it('labels an edited amount as the person entry, not as read clearly (issue 230)', async () => {
    const { user } = await renderLoaded();
    await user.click(within(row('Gross pay')).getByRole('button', { name: 'Edit Gross pay' }));
    const input = within(row('Gross pay')).getByRole('textbox', { name: 'Gross pay' });
    await user.clear(input);
    await user.type(input, '2,708.34{Enter}');
    expect(within(row('Gross pay')).queryByText('Read clearly')).not.toBeInTheDocument();
    expect(within(row('Gross pay')).getByText('Your entry')).toBeInTheDocument();
  });

  it('still asks for gross pay when the stub shows none: it cannot be none', async () => {
    const proposal = structuredClone(sampleProposal);
    Object.assign(
      proposal.fields!.find((f) => f.key === 'gross_cents')!,
      {
        value: null,
        note: 'Type it if the document shows it.',
      },
    );
    db.proposals.set(PAY_STUB_DOC_ID, proposal);
    const { user } = await renderLoaded();
    expect(row('Gross pay')).toHaveTextContent('Type it if the document shows it.');
    await user.click(within(row('Gross pay')).getByRole('button', { name: 'Confirm Gross pay' }));
    const input = within(row('Gross pay')).getByRole('textbox', { name: 'Gross pay' });
    expect(input).not.toHaveAttribute('aria-invalid', 'true');
    await user.type(input, '{Enter}');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(
      'Enter an amount, like 1,234.56 Type it if the document shows it.',
    );
  });

  it('Escape cancels the draft and puts the value back', async () => {
    const { user } = await renderLoaded();
    await user.click(within(row('Medicare')).getByRole('button', { name: 'Edit Medicare' }));
    const input = within(row('Medicare')).getByRole('textbox', { name: 'Medicare' });
    await user.clear(input);
    await user.type(input, '1{Escape}');
    expect(within(row('Medicare')).queryByRole('textbox')).not.toBeInTheDocument();
    expect(row('Medicare')).toHaveTextContent('$39.27');
    expect(within(row('Medicare')).getByRole('button', { name: 'Edit Medicare' })).toHaveFocus();
    expect(within(fieldsCard()).getByText('The math checks out.')).toBeInTheDocument();
  });

  it('Enter while an input method is composing keeps the draft open', async () => {
    const { user } = await renderLoaded();
    await user.click(within(row('Medicare')).getByRole('button', { name: 'Edit Medicare' }));
    const input = within(row('Medicare')).getByRole('textbox', { name: 'Medicare' });
    await user.clear(input);
    await user.type(input, '40.00');
    // The Enter that commits a composition belongs to the input method, not the row.
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(within(row('Medicare')).getByRole('textbox', { name: 'Medicare' })).toHaveValue('40.00');
    expect(
      within(row('Medicare')).queryByRole('button', { name: 'Confirmed Medicare' }),
    ).not.toBeInTheDocument();
  });

  it('edits a date with a date input and a frequency with a select', async () => {
    const { user } = await renderLoaded();
    await user.click(within(row('Pay date')).getByRole('button', { name: 'Edit Pay date' }));
    const date = within(row('Pay date')).getByLabelText('Pay date');
    expect(date).toHaveAttribute('type', 'date');
    expect(date).toHaveValue('2026-10-15');

    await user.click(
      within(row('Pay frequency')).getByRole('button', { name: 'Edit Pay frequency' }),
    );
    const frequency = within(row('Pay frequency')).getByRole('combobox', {
      name: 'Pay frequency',
    });
    await user.selectOptions(frequency, ['Every two weeks']);
    await user.click(
      within(row('Pay frequency')).getByRole('button', {
        name: 'Save and confirm Pay frequency',
      }),
    );
    expect(row('Pay frequency')).toHaveTextContent('Every two weeks');
  });

  it("renders the server's diff when confirm answers 422", async () => {
    server.use(
      http.post(apiUrl('/docs/:id/confirm'), () =>
        HttpResponse.json(
          {
            error: {
              code: 'pay_stub_unbalanced',
              message: 'Gross minus deductions is $1,996.04, but net is $1,996.06',
              details: {
                gross_cents: 270_833,
                deductions_cents: 71_229,
                net_cents: 199_606,
                expected_net_cents: 199_604,
                difference_cents: -2,
              },
            },
          },
          { status: 422 },
        ),
      ),
    );
    const { user } = await renderLoaded();
    await user.click(screen.getByRole('button', { name: 'Confirm all remaining' }));
    await user.click(continueButton());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("These don't add up, so nothing was saved.");
    const diff = within(alert).getByRole('list');
    expect(diff).toHaveTextContent('Gross pay$2,708.33');
    expect(diff).toHaveTextContent('Deductions$712.29');
    expect(diff).toHaveTextContent('Gross minus deductions$1,996.04');
    expect(diff).toHaveTextContent('Net pay$1,996.06');
    expect(diff).toHaveTextContent('Off by$0.02');
    expect(router.push).not.toHaveBeenCalled();

    // An edit makes the server's answer stale.
    await user.click(within(row('Medicare')).getByRole('button', { name: 'Edit Medicare' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it("shows other confirm errors in the API's words", async () => {
    server.use(
      http.post(apiUrl('/docs/:id/confirm'), () =>
        HttpResponse.json(
          {
            error: {
              code: 'document_deleted',
              message: "This document's file was deleted; upload it again",
            },
          },
          { status: 409 },
        ),
      ),
    );
    const { user } = await renderLoaded();
    await user.click(screen.getByRole('button', { name: 'Confirm all remaining' }));
    await user.click(continueButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Could not save these fields. This document's file was deleted; upload it again",
    );
  });
});

describe('ConfirmScreen after automatic reading was unavailable', () => {
  // Issue 163 and spec 004 rules 32-37.
  beforeEach(() => {
    db.documents = [sampleDocument({ status: 'manual_entry_required', status_reason: 'no_model' })];
    db.proposals.set(PAY_STUB_DOC_ID, structuredClone(manualEntryProposal));
  });

  it('says what happened then, without claiming the lines were read', async () => {
    await renderLoaded();
    expect(
      screen.getByText(/^Automatic reading was not available then, so nothing was filled in\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/right now/)).toBeNull();
    const pane = sourcePane();
    expect(pane).toHaveTextContent('Private numbers are hidden.');
    expect(pane).not.toHaveTextContent(/\bAI\b|redact|extract/i);
    expect(within(pane).getAllByRole('img', { name: 'Hidden number' })).toHaveLength(2);
  });

  it('reads it again, then shows what was read', async () => {
    const { user } = await renderLoaded();
    await user.click(screen.getByRole('button', { name: 'Read again' }));

    expect(
      await screen.findByRole('progressbar', { name: 'Reading pay stub' }),
    ).toBeInTheDocument();
    // The worker reads it (spec 004 rule 36): a proposal from the redacted pages.
    Object.assign(db.documents[0]!, { status: 'proposed', status_reason: null });
    db.proposals.set(PAY_STUB_DOC_ID, structuredClone(sampleProposal));
    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
    expect(await screen.findByRole('region', { name: 'What we read' })).toBeInTheDocument();
    expect(sourcePane()).toBeInTheDocument();
  });

  it('says why reading again could not start', async () => {
    server.use(
      http.post(apiUrl('/docs/:id/extract'), () =>
        HttpResponse.json(
          { error: { code: 'internal_error', message: 'Database is busy' } },
          { status: 500 },
        ),
      ),
    );
    const { user } = await renderLoaded();
    await user.click(screen.getByRole('button', { name: 'Read again' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not start reading the pay stub. Database is busy',
    );
  });
});

describe('ConfirmScreen manual entry', () => {
  beforeEach(() => {
    db.documents = [sampleDocument({ status: 'manual_entry_required', status_reason: 'refused' })];
    db.proposals.set(PAY_STUB_DOC_ID, structuredClone(manualEntryProposal));
  });

  it('starts every field empty and editable beside the redacted source', async () => {
    await renderLoaded();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Enter what your pay stub says',
    );
    expect(screen.getByText(/We could not read this document automatically/)).toBeInTheDocument();
    const inputs = within(fieldsCard()).getAllByRole('textbox');
    expect(inputs.length).toBe(10);
    expect(inputs.every((input) => (input as HTMLInputElement).value === '')).toBe(true);
    expect(within(fieldsCard()).getByRole('combobox', { name: 'Pay frequency' })).toHaveValue('');
    expect(within(fieldsCard()).queryByText(/Read clearly|Check this/)).not.toBeInTheDocument();
    expect(fieldsCard()).toHaveTextContent("Can't check the math yet. Gross pay is missing.");
    expect(within(sourcePane()).getAllByRole('img', { name: 'Hidden number' })).toHaveLength(2);
    expect(sourcePane()).toHaveTextContent('Type each amount from these lines.');
    // The AI read it and declined: nothing to read again (spec 004 rule 35).
    expect(screen.queryByRole('button', { name: 'Read again' })).toBeNull();
    expect(within(row('Gross pay')).queryByRole('button', { name: /^Cancel/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Confirm all remaining' })).toBeDisabled();
    expect(continueButton()).toBeDisabled();
  });

  it('saves what the person typed, field by field, and sends it', async () => {
    const bodies = confirmBodies();
    const { user } = await renderLoaded();
    const typed: Record<string, string> = {
      Employer: 'Acme Corp',
      'Pay date': '2026-10-15',
      'Period start': '2026-10-01',
      'Period end': '2026-10-15',
      'Gross pay': '2,708.33',
      'Federal income tax': '297.76',
      'Social Security': '167.92',
      Medicare: '39.27',
      'State income tax': '98.14',
      '401(k) contribution': '0',
      'Medical premium': '62.50',
      'Other deductions': '46.70',
      'Net pay': '1,996.04',
    };
    for (const [label, text] of Object.entries(typed)) {
      // A date input takes the ISO value directly; Enter saves the row.
      await user.type(within(row(label)).getByLabelText(label), `${text}{Enter}`);
    }
    await user.selectOptions(
      within(row('Pay frequency')).getByRole('combobox', { name: 'Pay frequency' }),
      ['Twice a month'],
    );
    await user.click(
      within(row('Pay frequency')).getByRole('button', {
        name: 'Save and confirm Pay frequency',
      }),
    );

    expect(fieldsCard()).toHaveTextContent('14 of 14 confirmed');
    expect(within(fieldsCard()).getByText('The math checks out.')).toBeInTheDocument();
    await user.click(continueButton());
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/setup/spending'));
    expect(bodies).toEqual([{ pay_stub: sampleValues }]);
  });
});

describe('ConfirmScreen document states', () => {
  it('shows a loading state, then the review', async () => {
    renderConfirm();
    expect(screen.getByText('Loading the document')).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'What we read' })).toBeInTheDocument();
  });

  it('follows a document still being read until it can be reviewed', async () => {
    db.documents = [sampleDocument({ status: 'extracting', page_count: null })];
    renderConfirm();
    expect(
      await screen.findByRole('progressbar', { name: 'Reading pay stub' }),
    ).toBeInTheDocument();
    db.documents = [sampleDocument()];
    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
    expect(await screen.findByRole('region', { name: 'What we read' })).toBeInTheDocument();
  });

  it('says a confirmed document is done, with nothing to check, and points on to Spending', async () => {
    db.documents = [sampleDocument({ status: 'confirmed' })];
    renderConfirm();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your pay stub is confirmed' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Your plan now uses the amounts you checked/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Continue to spending/ })).toHaveAttribute(
      'href',
      '/setup/spending',
    );
  });

  it('says a newer copy of the paycheck replaced a superseded one (issue 199)', async () => {
    db.documents = [sampleDocument({ status: 'confirmed', superseded: true })];
    renderConfirm();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'A newer copy replaced this pay stub' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('You confirmed this paycheck again, so the newer copy counts.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to documents' })).toHaveAttribute(
      'href',
      '/setup/link',
    );
  });

  it('explains a failed document and links back to replace it', async () => {
    db.documents = [
      sampleDocument({ status: 'failed', status_reason: 'unreadable_file', page_count: null }),
    ];
    renderConfirm();
    expect(await screen.findByText(/This file could not be opened/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to documents' })).toHaveAttribute(
      'href',
      '/setup/link',
    );
  });

  it('says a replaced document was replaced and opens the one that replaced it', async () => {
    db.documents = [
      sampleDocument({
        id: 'doc-new',
        status: 'proposed',
        uploaded_at: SAMPLE_NOW,
      }),
      sampleDocument({
        status: 'manual_entry_required',
        status_reason: 'no_model',
        deleted_at: SAMPLE_NOW,
        replaced_by_id: 'doc-new',
      }),
    ];
    renderConfirm();
    expect(
      await screen.findByText('This pay stub was replaced by a newer upload.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: FIELDS })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open the new pay stub/ })).toHaveAttribute(
      'href',
      '/setup/confirm/doc-new',
    );
    expect(screen.getByRole('link', { name: 'Back to documents' })).toHaveAttribute(
      'href',
      '/setup/link',
    );
  });

  it('says offer letters are kept but not read', async () => {
    db.documents = [{ ...sampleBenefitsDocument, type: 'offer_letter' }];
    renderConfirm(BENEFITS_DOC_ID);
    expect(
      await screen.findByText(/We keep offer letters but do not read them yet/),
    ).toBeInTheDocument();
    expect(document.title).toBe('Confirm offer letter | First Paycheck');
  });

  it('names the browser tab after the pay stub', async () => {
    await renderLoaded();
    expect(document.title).toBe('Confirm pay stub | First Paycheck');
  });

  it('says so when the document does not exist', async () => {
    renderConfirm('missing');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Document not found' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/not one of your documents, or it was removed/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to documents' })).toBeInTheDocument();
  });

  it('reads the same for any 404, whatever its message (a malformed id)', async () => {
    // The API answers a path id that is not an id with 404 not_found "Not found".
    server.use(
      http.get(apiUrl('/docs/:id'), () =>
        HttpResponse.json({ error: { code: 'not_found', message: 'Not found' } }, { status: 404 }),
      ),
    );
    renderConfirm('not-a-uuid');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Document not found' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('still says why when the document could not be loaded for another reason', async () => {
    server.use(
      http.get(apiUrl('/docs/:id'), () =>
        HttpResponse.json(
          { error: { code: 'service_unavailable', message: 'Database is busy' } },
          { status: 503 },
        ),
      ),
    );
    renderConfirm();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load this document. Database is busy',
    );
  });
});

describe('ConfirmScreen benefits summary', () => {
  const BENEFITS_FIELDS = 'Plans and 401(k) match';
  const benefitsCard = () => screen.getByRole('region', { name: BENEFITS_FIELDS });
  const benefitsRow = (name: string) => within(benefitsCard()).getByRole('group', { name });

  async function renderBenefits() {
    const rendered = renderConfirm(BENEFITS_DOC_ID);
    await screen.findByRole('region', { name: BENEFITS_FIELDS });
    return rendered;
  }

  beforeEach(() => {
    db.documents = [];
    benefitsWaiting();
  });

  it('lists each plan, the match tiers and vesting with their confidence', async () => {
    await renderBenefits();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Check what we read from your benefits summary',
    );
    expect(benefitsCard()).toHaveTextContent('0 of 29 confirmed');
    for (const heading of ['Plan 1: Bronze HSA', 'Plan 2: Gold PPO', '401(k) match']) {
      expect(
        within(benefitsCard()).getByRole('heading', { level: 3, name: heading }),
      ).toBeInTheDocument();
    }
    expect(benefitsRow('Plan 1: Plan type')).toHaveTextContent('High deductible (HDHP)');
    expect(benefitsRow('Plan 1: Deductible')).toHaveTextContent('$1,800.00');
    expect(benefitsRow('Plan 2: Coinsurance')).toHaveTextContent('10%');
    expect(within(benefitsRow('Plan 2: Coinsurance')).getByText('Check this')).toBeInTheDocument();
    expect(benefitsRow('Plan 2: Enrollment deadline')).toHaveTextContent('Nov 14, 2026');
    expect(benefitsRow('Tier 1: Employer match')).toHaveTextContent('100%');
    expect(benefitsRow('Tier 2: Matched up to (% of pay)')).toHaveTextContent(
      'Cumulative: 2.00% added to the tiers before it',
    );
    expect(benefitsRow('Years to full vesting')).toHaveTextContent('3 years');

    const pane = screen.getByRole('complementary', { name: 'Your benefits summary' });
    expect(within(pane).getByRole('list', { name: 'Benefits summary text' })).toBeInTheDocument();
    expect(within(pane).getByText('No numbers hidden')).toBeInTheDocument();
    expect(within(pane).getByText('ACME CORP 2027 BENEFITS SUMMARY')).toBeInTheDocument();
    expect(pane).toHaveTextContent('Find each value in these lines');
    expect(
      within(pane)
        .getAllByRole('listitem')
        .filter((li) => li.getAttribute('aria-current') === 'true'),
    ).toHaveLength(0);
  });

  it('edits a field, confirms the rest and sends the plans and the match', async () => {
    const bodies = confirmBodies();
    const { user } = await renderBenefits();
    await user.click(
      within(benefitsRow('Plan 1: Deductible')).getByRole('button', {
        name: 'Edit Plan 1: Deductible',
      }),
    );
    const input = within(benefitsRow('Plan 1: Deductible')).getByLabelText('Plan 1: Deductible');
    await user.clear(input);
    await user.type(input, '2,000{Enter}');
    expect(benefitsRow('Plan 1: Deductible')).toHaveTextContent('$2,000.00');

    await user.click(
      within(benefitsRow('Years to full vesting')).getByRole('button', {
        name: 'Edit Years to full vesting',
      }),
    );
    expect(
      within(benefitsRow('Years to full vesting')).getByRole('combobox', {
        name: 'Years to full vesting',
      }),
    ).toHaveDisplayValue('3 years');
    await user.click(
      within(benefitsRow('Years to full vesting')).getByRole('button', {
        name: 'Save and confirm Years to full vesting',
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Confirm all remaining' }));
    expect(benefitsCard()).toHaveTextContent('29 of 29 confirmed');
    await user.click(continueButton());

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your benefits summary is confirmed' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/401\(k\) match and vesting now come from this summary/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Continue to decisions/ })).toHaveAttribute(
      'href',
      '/setup/decisions/health-plan',
    );
    const [bronze, gold, saver] = sampleBenefitsValues.plans;
    expect(bodies).toEqual([
      {
        benefits: {
          ...sampleBenefitsValues,
          plans: [{ ...bronze, deductible_cents: 200_000 }, gold, saver],
        },
      },
    ]);
    expect(planningDb.benefitsPlans).toHaveLength(3);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('needs every required value before continuing', async () => {
    const proposal = structuredClone(sampleBenefitsProposal);
    proposal.plans![1]!.fields[0]!.value = null;
    db.proposals.set(BENEFITS_DOC_ID, proposal);
    const { user } = await renderBenefits();
    await user.click(screen.getByRole('button', { name: 'Confirm all remaining' }));
    expect(benefitsCard()).toHaveTextContent('28 of 29 confirmed');
    expect(continueButton()).toBeDisabled();
    expect(screen.getByText('1 left to confirm')).toBeInTheDocument();

    await user.click(
      within(benefitsRow('Plan 2: Plan name')).getByRole('button', {
        name: 'Confirm Plan 2: Plan name',
      }),
    );
    const name = within(benefitsRow('Plan 2: Plan name')).getByLabelText('Plan 2: Plan name');
    expect(name).toHaveFocus();
    // Nothing is wrong before the person types or saves (issue 195).
    expect(within(benefitsRow('Plan 2: Plan name')).queryByText('Enter a value')).toBeNull();
    await user.type(name, '{Enter}');
    expect(within(benefitsRow('Plan 2: Plan name')).getByText('Enter a value')).toBeInTheDocument();
    await user.type(name, 'Gold PPO{Enter}');
    expect(continueButton()).toBeEnabled();
  });

  it("shows the server's refusal and keeps what the person checked", async () => {
    const { user } = await renderBenefits();
    await user.click(
      within(benefitsRow('Plan 1: Deductible')).getByRole('button', {
        name: 'Edit Plan 1: Deductible',
      }),
    );
    const input = within(benefitsRow('Plan 1: Deductible')).getByLabelText('Plan 1: Deductible');
    await user.clear(input);
    await user.type(input, '4,000{Enter}');
    await user.click(screen.getByRole('button', { name: 'Confirm all remaining' }));
    await user.click(continueButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Could not save these fields. A plan's deductible must not be more than its out-of-pocket maximum",
    );
    expect(benefitsCard()).toHaveTextContent('29 of 29 confirmed');
    expect(planningDb.benefitsPlans).toHaveLength(0);
  });

  it('sends no match when the summary describes none, and says the profile keeps its own', async () => {
    const proposal = structuredClone(sampleBenefitsProposal);
    proposal.match_tiers = [];
    proposal.vesting_years = null;
    db.proposals.set(BENEFITS_DOC_ID, proposal);
    const bodies = confirmBodies();
    const { user } = await renderBenefits();
    expect(benefitsCard()).toHaveTextContent('0 of 24 confirmed');
    expect(benefitsCard()).toHaveTextContent(
      'No 401(k) match was found in this summary, so your plan details keep the match you entered.',
    );
    await user.click(screen.getByRole('button', { name: 'Confirm all remaining' }));
    await user.click(continueButton());
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your benefits summary is confirmed' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/401\(k\) match and vesting now come/)).toBeNull();
    expect(bodies).toEqual([{ benefits: { plans: sampleBenefitsValues.plans, retirement: null } }]);
  });

  it('points a summary nothing could be read from to the decision cards', async () => {
    db.documents = [{ ...sampleBenefitsDocument, status: 'manual_entry_required' }];
    renderConfirm(BENEFITS_DOC_ID);
    expect(
      await screen.findByText(/Enter your health plans on the health plan step/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Go to decisions/ })).toHaveAttribute(
      'href',
      '/setup/decisions/health-plan',
    );
  });

  it('says a confirmed summary is done and points on to Decisions', async () => {
    db.documents = [{ ...sampleBenefitsDocument, status: 'confirmed' }];
    renderConfirm(BENEFITS_DOC_ID);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your benefits summary is confirmed' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Continue to decisions/ })).toHaveAttribute(
      'href',
      '/setup/decisions/health-plan',
    );
  });

  it.each([
    ['proposed', () => screen.findByRole('region', { name: BENEFITS_FIELDS })],
    ['extracting', () => screen.findByRole('progressbar', { name: 'Reading benefits summary' })],
    [
      'confirmed',
      () => screen.findByRole('heading', { name: 'Your benefits summary is confirmed' }),
    ],
    ['manual_entry_required', () => screen.findByText(/Enter your health plans/)],
  ] as const)('names the browser tab after the benefits summary when %s', async (status, shown) => {
    if (status !== 'proposed') db.documents = [{ ...sampleBenefitsDocument, status }];
    renderConfirm(BENEFITS_DOC_ID);
    await shown();
    expect(document.title).toBe('Confirm benefits summary | First Paycheck');
  });

  it('follows a benefits summary still being read', async () => {
    db.documents = [{ ...sampleBenefitsDocument, status: 'extracting' }];
    renderConfirm(BENEFITS_DOC_ID);
    expect(
      await screen.findByRole('progressbar', { name: 'Reading benefits summary' }),
    ).toBeInTheDocument();
  });
});

describe('ConfirmScreen confirmed values (issue 243)', () => {
  const confirmedValues = () => screen.getByRole('region', { name: 'What you confirmed' });
  const value = (label: string) =>
    within(confirmedValues()).getByText(label, { selector: 'dt' }).nextElementSibling;

  it('lists a confirmed pay stub as it was confirmed, with nothing to edit', async () => {
    db.documents = [confirmedDocument()];
    db.payStubs = [samplePayStub()];
    renderConfirm();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your pay stub is confirmed' }),
    ).toBeInTheDocument();
    expect(value('Employer')).toHaveTextContent('Acme Corp');
    expect(value('Pay date')).toHaveTextContent('Oct 15, 2026');
    expect(value('Pay period')).toHaveTextContent('Oct 1, 2026 to Oct 15, 2026');
    expect(value('Pay frequency')).toHaveTextContent('Semi-monthly');
    expect(value('Gross pay')).toHaveTextContent('$2,708.33');
    expect(value('Federal income tax')).toHaveTextContent('$297.76');
    expect(value('401(k) contribution')).toHaveTextContent('$0.00');
    expect(value('Other deductions')).toHaveTextContent('$46.70');
    expect(value('Net pay')).toHaveTextContent('$1,996.04');
    expect(within(confirmedValues()).queryByRole('button')).toBeNull();
    expect(within(confirmedValues()).queryByRole('textbox')).toBeNull();
  });

  it('says what a stub without an employer or schedule left out', async () => {
    db.documents = [confirmedDocument({ employer_name: null })];
    db.payStubs = [samplePayStub({ employer_name: null, pay_frequency: null })];
    renderConfirm();
    await screen.findByRole('region', { name: 'What you confirmed' });
    expect(value('Employer')).toHaveTextContent('Not shown on the stub');
    expect(value('Pay frequency')).toHaveTextContent('Not shown on the stub');
  });

  it('lists a superseded copy too, under its own title', async () => {
    db.documents = [confirmedDocument({ superseded: true })];
    db.payStubs = [samplePayStub()];
    renderConfirm();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'A newer copy replaced this pay stub' }),
    ).toBeInTheDocument();
    expect(value('Net pay')).toHaveTextContent('$1,996.04');
  });

  it('lists a confirmed summary plan by plan', async () => {
    db.documents = [
      confirmedDocument({
        ...sampleBenefitsDocument,
        status: 'confirmed',
        employer_name: null,
        pay_date: null,
        plan_names: ['Bronze HSA', 'Gold PPO', 'Saver HDHP'],
      }),
    ];
    benefitsConfirmed();
    renderConfirm(BENEFITS_DOC_ID);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your benefits summary is confirmed' }),
    ).toBeInTheDocument();
    const gold = within(confirmedValues()).getByRole('group', { name: 'Gold PPO' });
    expect(
      within(gold).getByText('Plan type', { selector: 'dt' }).nextElementSibling,
    ).toHaveTextContent('PPO');
    expect(
      within(gold).getByText('Deductible', { selector: 'dt' }).nextElementSibling,
    ).toHaveTextContent('$250.00');
    expect(
      within(confirmedValues())
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(['Bronze HSA', 'Gold PPO', 'Saver HDHP']);
    expect(within(confirmedValues()).queryByRole('button')).toBeNull();
  });

  it('shows no values for a confirmed document the API has none for', async () => {
    db.documents = [confirmedDocument()];
    db.payStubs = [];
    renderConfirm();
    await screen.findByRole('heading', { level: 1, name: 'Your pay stub is confirmed' });
    expect(screen.queryByRole('region', { name: 'What you confirmed' })).toBeNull();
  });
});
