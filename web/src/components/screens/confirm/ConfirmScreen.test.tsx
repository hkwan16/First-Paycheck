import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_POLL_MS, usePayStubs } from '@/lib/api/hooks';
import {
  BENEFITS_DOC_ID,
  manualEntryProposal,
  PAY_STUB_DOC_ID,
  sampleBenefitsDocument,
  sampleDocument,
  sampleValues,
} from '@/test/fixtures/documents';
import { SAMPLE_NOW } from '@/test/fixtures/sample';
import { sampleBenefitsProposal, sampleBenefitsValues } from '@/test/fixtures/planning';
import { db } from '@/test/msw/db';
import { apiUrl } from '@/test/msw/handlers';
import { benefitsWaiting, planningDb } from '@/test/msw/planning-handlers';
import { server } from '@/test/msw/server';
import { act, renderWithProviders, screen, waitFor, within } from '@/test/render';
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

const FIELDS = /^(Extracted fields|Pay stub fields)$/;
const fieldsCard = () => screen.getByRole('region', { name: FIELDS });
const sourcePane = () => screen.getByRole('complementary', { name: 'Source, as the AI saw it' });
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
    expect(within(row('Gross pay')).getByText('Read · 99%')).toBeInTheDocument();
    expect(within(row('401(k) contribution')).getByText('Check · 74%')).toBeInTheDocument();
    expect(row('Pay date')).toHaveTextContent('Oct 15, 2026');
    expect(row('Pay frequency')).toHaveTextContent('Twice a month');
    expect(row('Other deductions')).toHaveTextContent('Sum of: CA SDI, DENTAL/VIS');
    expect(within(row('Other deductions')).getByText('Added up')).toBeInTheDocument();

    const bar = within(fieldsCard()).getByRole('progressbar', { name: 'Fields confirmed' });
    expect(bar).toHaveAttribute('aria-valuenow', '0');
    expect(within(fieldsCard()).getByText('The math checks out.')).toBeInTheDocument();
    expect(continueButton()).toBeDisabled();
    expect(screen.getByText('14 left to confirm')).toBeInTheDocument();
  });

  it('shows the redacted source with the selected field highlighted', async () => {
    const { user } = await renderLoaded();
    const pane = sourcePane();
    expect(within(pane).getByText('2 items redacted')).toBeInTheDocument();
    expect(within(pane).getAllByRole('img', { name: 'Redacted' })).toHaveLength(2);
    expect(pane).not.toHaveTextContent('[REDACTED]');
    expect(highlighted()).toHaveLength(1);
    expect(highlighted()[0]).toHaveTextContent('GROSS PAY2,708.33');
    expect(pane).toHaveTextContent('Highlighted line: Gross pay.');

    await user.click(within(row('Net pay')).getByRole('button', { name: /^Net pay/ }));
    expect(highlighted()[0]).toHaveTextContent('NET PAY1,996.04');
    expect(pane).toHaveTextContent('Highlighted line: Net pay.');

    await user.click(within(row('Period end')).getByRole('button', { name: /^Period end/ }));
    expect(highlighted()).toHaveLength(0);
    expect(pane).toHaveTextContent('Period end has no line of its own in the source.');
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

    await screen.findByText('This pay stub is confirmed.');
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
      'Gross minus deductions is off from net pay by $0.02. Check the edited field.',
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

  it('shows "?" while a draft is not an amount, and says why on save', async () => {
    const { user } = await renderLoaded();
    await user.click(within(row('Gross pay')).getByRole('button', { name: 'Edit Gross pay' }));
    const input = within(row('Gross pay')).getByRole('textbox', { name: 'Gross pay' });
    await user.clear(input);
    await user.type(input, '2,708.3x');
    expect(fieldsCard()).toHaveTextContent(
      "Can't check the math yet. Gross pay is not an amount yet, so the difference is $?.",
    );
    await user.type(input, '{Enter}');
    expect(input).toHaveAccessibleDescription('Enter an amount, like 1,234.56');
    expect(input).toHaveAttribute('aria-invalid', 'true');
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
              message: 'Gross minus deductions is 199604 cents, but net is 199606 cents',
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
    expect(alert).toHaveTextContent("The server found that these don't add up.");
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
    expect(screen.getByText(/The AI declined to read this document/)).toBeInTheDocument();
    const inputs = within(fieldsCard()).getAllByRole('textbox');
    expect(inputs.length).toBe(10);
    expect(inputs.every((input) => (input as HTMLInputElement).value === '')).toBe(true);
    expect(within(fieldsCard()).getByRole('combobox', { name: 'Pay frequency' })).toHaveValue('');
    expect(within(fieldsCard()).queryByText(/Read ·|Check ·/)).not.toBeInTheDocument();
    expect(fieldsCard()).toHaveTextContent(
      "Can't check the math yet. Gross pay is missing, so the difference is $?.",
    );
    expect(within(sourcePane()).getAllByRole('img', { name: 'Redacted' })).toHaveLength(2);
    expect(sourcePane()).toHaveTextContent('Type each field from these lines.');
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
      const input = within(row(label)).getByLabelText(label);
      if (input.getAttribute('type') === 'date') {
        // A date input takes the ISO value directly.
        await user.clear(input);
        await user.type(input, text);
      } else {
        await user.type(input, text);
      }
      await user.type(input, '{Enter}');
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
    expect(await screen.findByRole('region', { name: 'Extracted fields' })).toBeInTheDocument();
  });

  it('follows a document still being read until it can be reviewed', async () => {
    db.documents = [sampleDocument({ status: 'extracting', page_count: null })];
    renderConfirm();
    expect(
      await screen.findByRole('progressbar', { name: 'Reading pay stub' }),
    ).toBeInTheDocument();
    db.documents = [sampleDocument()];
    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
    expect(await screen.findByRole('region', { name: 'Extracted fields' })).toBeInTheDocument();
  });

  it('says a confirmed document is done and points on to Spending', async () => {
    db.documents = [sampleDocument({ status: 'confirmed' })];
    renderConfirm();
    expect(await screen.findByText(/This pay stub is confirmed/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Continue to spending/ })).toHaveAttribute(
      'href',
      '/setup/spending',
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

  it('says offer letters are kept but not read', async () => {
    db.documents = [{ ...sampleBenefitsDocument, type: 'offer_letter' }];
    renderConfirm(BENEFITS_DOC_ID);
    expect(await screen.findByText(/Offer letters are kept but not read yet/)).toBeInTheDocument();
  });

  it('says so when the document does not exist', async () => {
    renderConfirm('missing');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load this document. Document not found',
    );
    expect(screen.getByRole('link', { name: 'Back to documents' })).toBeInTheDocument();
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
    expect(benefitsCard()).toHaveTextContent('0 of 21 confirmed');
    for (const heading of ['Plan 1: Bronze HSA', 'Plan 2: Gold PPO', '401(k) match']) {
      expect(
        within(benefitsCard()).getByRole('heading', { level: 3, name: heading }),
      ).toBeInTheDocument();
    }
    expect(benefitsRow('Plan 1: Plan type')).toHaveTextContent('High deductible (HDHP)');
    expect(benefitsRow('Plan 1: Deductible')).toHaveTextContent('$1,800.00');
    expect(benefitsRow('Plan 2: Coinsurance')).toHaveTextContent('10%');
    expect(within(benefitsRow('Plan 2: Coinsurance')).getByText('Check · 82%')).toBeInTheDocument();
    expect(benefitsRow('Plan 2: Enrollment deadline')).toHaveTextContent('Nov 14, 2026');
    expect(benefitsRow('Tier 1: Employer match')).toHaveTextContent('100%');
    expect(benefitsRow('Tier 2: Matched up to (% of pay)')).toHaveTextContent(
      'Cumulative: 2.00% added to the tiers before it',
    );
    expect(benefitsRow('Years to full vesting')).toHaveTextContent('3 years');

    const pane = sourcePane();
    expect(
      within(pane).getByRole('list', { name: 'Redacted benefits summary' }),
    ).toBeInTheDocument();
    expect(within(pane).getByText('0 items redacted')).toBeInTheDocument();
    expect(within(pane).getByText('ACME CORP 2027 BENEFITS SUMMARY')).toBeInTheDocument();
    expect(pane).toHaveTextContent('Find each value in these lines');
    expect(highlighted()).toHaveLength(0);
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
    expect(benefitsCard()).toHaveTextContent('21 of 21 confirmed');
    await user.click(continueButton());

    expect(await screen.findByText('Your benefits summary is confirmed.')).toBeInTheDocument();
    expect(
      screen.getByText(/401\(k\) match and vesting now come from this summary/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Continue to decisions/ })).toHaveAttribute(
      'href',
      '/setup/decisions',
    );
    const [bronze, gold] = sampleBenefitsValues.plans;
    expect(bodies).toEqual([
      {
        benefits: {
          ...sampleBenefitsValues,
          plans: [{ ...bronze, deductible_cents: 200_000 }, gold],
        },
      },
    ]);
    expect(planningDb.benefitsPlans).toHaveLength(2);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('needs every required value before continuing', async () => {
    const proposal = structuredClone(sampleBenefitsProposal);
    proposal.plans![1]!.fields[0]!.value = null;
    db.proposals.set(BENEFITS_DOC_ID, proposal);
    const { user } = await renderBenefits();
    await user.click(screen.getByRole('button', { name: 'Confirm all remaining' }));
    expect(benefitsCard()).toHaveTextContent('20 of 21 confirmed');
    expect(continueButton()).toBeDisabled();
    expect(screen.getByText('1 left to confirm')).toBeInTheDocument();

    await user.click(
      within(benefitsRow('Plan 2: Plan name')).getByRole('button', {
        name: 'Confirm Plan 2: Plan name',
      }),
    );
    expect(within(benefitsRow('Plan 2: Plan name')).getByText('Enter a value')).toBeInTheDocument();
    await user.type(
      within(benefitsRow('Plan 2: Plan name')).getByLabelText('Plan 2: Plan name'),
      'Gold PPO{Enter}',
    );
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
      'Could not save these fields. deductible_cents must not exceed oop_max_cents',
    );
    expect(benefitsCard()).toHaveTextContent('21 of 21 confirmed');
    expect(planningDb.benefitsPlans).toHaveLength(0);
  });

  it('sends no match when the summary describes none, and says the profile keeps its own', async () => {
    const proposal = structuredClone(sampleBenefitsProposal);
    proposal.match_tiers = [];
    proposal.vesting_years = null;
    db.proposals.set(BENEFITS_DOC_ID, proposal);
    const bodies = confirmBodies();
    const { user } = await renderBenefits();
    expect(benefitsCard()).toHaveTextContent('0 of 16 confirmed');
    expect(benefitsCard()).toHaveTextContent(
      'No 401(k) match was found in this summary, so your plan details keep the match you entered.',
    );
    await user.click(screen.getByRole('button', { name: 'Confirm all remaining' }));
    await user.click(continueButton());
    expect(await screen.findByText('Your benefits summary is confirmed.')).toBeInTheDocument();
    expect(screen.queryByText(/401\(k\) match and vesting now come/)).toBeNull();
    expect(bodies).toEqual([{ benefits: { plans: sampleBenefitsValues.plans, retirement: null } }]);
  });

  it('points a summary nothing could be read from to the decision cards', async () => {
    db.documents = [{ ...sampleBenefitsDocument, status: 'manual_entry_required' }];
    renderConfirm(BENEFITS_DOC_ID);
    expect(
      await screen.findByText(/Enter your health plans on the health plan card/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Go to decisions/ })).toHaveAttribute(
      'href',
      '/setup/decisions',
    );
  });

  it('says a confirmed summary is done and points on to Decisions', async () => {
    db.documents = [{ ...sampleBenefitsDocument, status: 'confirmed' }];
    renderConfirm(BENEFITS_DOC_ID);
    expect(await screen.findByText('This benefits summary is confirmed.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Continue to decisions/ })).toHaveAttribute(
      'href',
      '/setup/decisions',
    );
  });

  it('follows a benefits summary still being read', async () => {
    db.documents = [{ ...sampleBenefitsDocument, status: 'extracting' }];
    renderConfirm(BENEFITS_DOC_ID);
    expect(
      await screen.findByRole('progressbar', { name: 'Reading benefits summary' }),
    ).toBeInTheDocument();
  });
});
