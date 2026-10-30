import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CALC_DEBOUNCE_MS } from '@/lib/api/hooks';
import { sampleDecision, stub01K401 } from '@/test/fixtures/decisions';
import { stub01PayStub } from '@/test/fixtures/documents';
import { stub01HealthDecision } from '@/test/fixtures/planning';
import { SAMPLE_NOW } from '@/test/fixtures/sample';
import {
  NO_DECISIONS,
  sampleW4,
  sampleW4Decision,
  sampleW4Inputs,
  stub01W4Inputs,
  W4_DECISION_ID,
} from '@/test/fixtures/w4';
import { db, decisionsReady, savedDecision, stub01Ready } from '@/test/msw/db';
import { apiUrl } from '@/test/msw/handlers';
import { savedHealthPlan, savedW4 } from '@/test/msw/planning-handlers';
import { server } from '@/test/msw/server';
import { act, fireEvent, renderWithProviders, screen, waitFor, within } from '@/test/render';
import { W4Card } from './W4Card';

/** Request bodies by route, in order. */
function requests() {
  const seen = {
    calc: [] as Record<string, unknown>[],
    calcAt: [] as number[],
    save: [] as Record<string, unknown>[],
  };
  server.events.on('request:start', async ({ request }) => {
    const path = new URL(request.url).pathname;
    if (path === '/calc/w4') {
      seen.calcAt.push(Date.now());
      seen.calc.push(await request.clone().json());
    }
    if (path === '/decisions' && request.method === 'POST') {
      seen.save.push(await request.clone().json());
    }
  });
  return seen;
}

const TITLE = 'W-4, federal only';
const card = () => screen.getByRole('region', { name: TITLE });
const result = () => within(card()).getByRole('group', { name: 'Calculator result' });
const decided = () => within(card()).getByRole('group', { name: 'From your decisions' });
const filing = () => within(card()).getByRole('group', { name: 'Filing status' });
const suggestion = () => within(card()).queryByRole('group', { name: 'Suggestion' });
const unchanged = () => within(result()).getByRole('group', { name: 'If you change nothing' });
const field = (label: string) => within(card()).getByLabelText(label);
const saveButton = () => within(card()).getByRole('button', { name: /^Save|^Saved/ });
const settle = () => act(() => vi.advanceTimersByTimeAsync(CALC_DEBOUNCE_MS));
const type = (label: string, value: string) =>
  fireEvent.change(field(label), { target: { value } });

const STEP_4C = 'Step 4(c): extra withholding each paycheck';
const STEP_4B = 'Step 4(b): deductions for the year';
const EXPECTED = 'Deductions you expect to claim';

/** The other decisions saved: the 401(k) at 4% and the Gold PPO at $62.50 a paycheck. */
function otherDecisionsSaved() {
  savedDecision();
  savedHealthPlan();
}

function renderCard() {
  return renderWithProviders(<W4Card />, { advanceTimers: vi.advanceTimersByTime });
}

/** Rendered with a result in place for the inputs on screen. */
async function renderReady() {
  const rendered = renderCard();
  await within(await screen.findByRole('region', { name: TITLE })).findByRole('group', {
    name: 'Filing status',
  });
  await settle();
  await waitFor(() => expect(result()).toHaveTextContent('at tax time'));
  await waitFor(() => expect(result()).not.toHaveAttribute('aria-busy', 'true'));
  return rendered;
}

/** Wait out the debounce and the request after a change. */
async function recalculated(text: string) {
  await settle();
  await waitFor(() => expect(result()).toHaveTextContent(text));
  await waitFor(() => expect(result()).not.toHaveAttribute('aria-busy', 'true'));
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(SAMPLE_NOW) }));
afterEach(() => {
  vi.useRealTimers();
  server.events.removeAllListeners();
});

describe('W4Card', () => {
  it('reads the saved 401(k) and health plan decisions and shows the projection', async () => {
    otherDecisionsSaved();
    const seen = requests();
    await renderReady();

    expect(card()).toHaveTextContent(
      'Your Oct 15 pay stub withholds $297.76 of federal income tax a paycheck.',
    );
    expect(decided()).toHaveTextContent('401(k) contribution4% of salary');
    expect(decided()).toHaveTextContent('Health premium per paycheck$62.50, Gold PPO');
    expect(within(decided()).queryByRole('link')).toBeNull();
    expect(
      within(filing()).getByRole('button', { name: 'Single or married filing separately' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(seen.calc).toEqual([sampleW4().inputs]);

    expect(result()).toHaveTextContent('A $0.08 refund at tax time');
    expect(result()).toHaveTextContent('Withheld each paycheck$213.67');
    expect(result()).toHaveTextContent('Withheld this year, 24 paychecks$5,128.08');
    expect(result()).toHaveTextContent('Projected 2026 federal income tax$5,128.00');
    expect(result()).toHaveTextContent('Refund or balance due$0.08 refund');
    expect(result()).toHaveTextContent('Taxable wages each paycheck$2,537.50');
    expect(result()).toHaveTextContent('Standard schedule, 12% row');
    expect(suggestion()).toBeNull();
    expect(saveButton()).toHaveTextContent('Save this decision');
    expect(saveButton()).toBeEnabled();

    // Beside it, what the stub's $297.76 a paycheck leaves at tax time (spec 014 rule 10a).
    expect(unchanged()).toHaveTextContent('If you change nothing');
    expect(unchanged()).toHaveTextContent('A $2,018.24 refund at tax time');
    expect(unchanged()).toHaveTextContent(
      'Your Oct 15 pay stub withholds $297.76 a paycheck: $7,146.24 over 24 paychecks, if every paycheck this year withholds the same.',
    );
    expect(result()).toHaveTextContent('With the entries above');
  });

  it('works without the other decisions, says they count as zero and links to their cards', async () => {
    decisionsReady();
    const seen = requests();
    await renderReady();

    expect(seen.calc).toEqual([sampleW4Inputs(NO_DECISIONS)]);
    expect(decided()).toHaveTextContent('401(k) contributionNot saved yet');
    expect(decided()).toHaveTextContent('Health premium per paycheckNot saved yet');
    expect(decided()).toHaveTextContent(
      'The projection counts a decision that is not saved yet as zero.',
    );
    expect(
      within(decided()).getByRole('link', { name: 'Save your 401(k) decision' }),
    ).toHaveAttribute('href', '/setup/decisions/401k');
    expect(
      within(decided()).getByRole('link', { name: 'Choose your health plan' }),
    ).toHaveAttribute('href', '/setup/decisions/health-plan');
    expect(result()).toHaveTextContent('Withheld each paycheck$234.17');
  });

  it('sends no age without a birth year', async () => {
    otherDecisionsSaved();
    db.profile = { ...db.profile, birth_year: null };
    const seen = requests();
    await renderReady();
    expect(seen.calc).toEqual([sampleW4Inputs({ age: null })]);
  });

  it('asks for the filing status before it calculates when the profile has none', async () => {
    otherDecisionsSaved();
    db.profile = { ...db.profile, filing_status: null };
    const seen = requests();
    const { user } = renderCard();
    const status = await within(await screen.findByRole('region', { name: TITLE })).findByRole(
      'group',
      { name: 'Filing status' },
    );
    expect(result()).toHaveTextContent('Choose your filing status to see your numbers.');
    expect(saveButton()).toBeDisabled();
    await settle();
    expect(seen.calc).toEqual([]);

    await user.click(within(status).getByRole('button', { name: 'Head of household' }));
    await recalculated('Even at tax time');
    expect(seen.calc).toEqual([sampleW4Inputs({ filing_status: 'head_of_household' })]);
  });

  it('sends one request after an entry stops changing and measures the debounce', async () => {
    otherDecisionsSaved();
    const seen = requests();
    await renderReady();
    type(STEP_4C, '10');
    type(STEP_4C, '100');
    const stoppedAt = Date.now();
    expect(result()).toHaveAttribute('aria-busy', 'true');
    await recalculated('A $2,400.08 refund at tax time');
    expect(seen.calc.map((body) => body.extra_withholding_cents)).toEqual([0, 10_000]);
    expect(seen.calcAt[1]! - stoppedAt).toBeGreaterThanOrEqual(CALC_DEBOUNCE_MS);
  });

  it('says what to fix in an amount, and calculates nothing until it reads', async () => {
    otherDecisionsSaved();
    const seen = requests();
    await renderReady();
    type('Step 3: dependent credits for the year', 'two');
    expect(field('Step 3: dependent credits for the year')).toHaveAccessibleDescription(
      'Enter an amount, like 2,200.00.',
    );
    expect(result()).toHaveTextContent('Enter each amount, or 0, to see your numbers.');
    expect(saveButton()).toBeDisabled();

    type('Step 3: dependent credits for the year', '2,200');
    await recalculated('Even at tax time');
    expect(seen.calc.at(-1)).toEqual(sampleW4Inputs({ dependents_credit_cents: 220_000 }));
  });
});

describe('W4Card at the stub withholding (spec 014 rule 10a, issue 153)', () => {
  it("states the e2e account's balance due at its stub's $272.44 beside the entries' projection", async () => {
    // Stub-01 ($3,653.85 biweekly, $272.44 federal), single, the 401(k) at 5% and a $4.00 premium.
    stub01Ready();
    db.decisions = [
      sampleDecision({ inputs: { ...stub01K401(5).inputs }, result: { ...stub01K401(5).result } }),
      stub01HealthDecision(),
    ];
    const seen = requests();
    await renderReady();

    expect(seen.calc).toEqual([stub01W4Inputs()]);
    expect(card()).toHaveTextContent(
      'Your Apr 10 pay stub withholds $272.44 of federal income tax a paycheck.',
    );
    expect(unchanged()).toHaveTextContent('$3,918.70 due at tax time');
    expect(unchanged()).toHaveTextContent(
      'Your Apr 10 pay stub withholds $272.44 a paycheck: $7,083.44 over 26 paychecks, if every paycheck this year withholds the same.',
    );
    expect(unchanged()).toHaveTextContent(
      'It changes only when you give your employer a new Form W-4.',
    );
    expect(result()).toHaveTextContent('A $0.02 refund at tax time');
    expect(result()).toHaveTextContent('Withheld each paycheck$423.16');
    expect(result()).toHaveTextContent('Projected 2026 federal income tax$11,002.14');
  });

  it('compares a stub that withholds nothing: the whole tax is due', async () => {
    stub01Ready();
    db.payStubs = [stub01PayStub({ federal_withholding_cents: 0, net_cents: 302_330 })];
    db.decisions = [
      sampleDecision({ inputs: { ...stub01K401(5).inputs }, result: { ...stub01K401(5).result } }),
      stub01HealthDecision(),
    ];
    const seen = requests();
    await renderReady();
    expect(seen.calc).toEqual([stub01W4Inputs({ current_withholding_per_paycheck_cents: 0 })]);
    expect(unchanged()).toHaveTextContent('$11,002.14 due at tax time');
  });

  it('says why there is no comparison when the stub is on another pay schedule', async () => {
    otherDecisionsSaved();
    db.payStubs = db.payStubs.map((stub) => ({ ...stub, pay_frequency: 'biweekly' as const }));
    const seen = requests();
    await renderReady();
    expect(seen.calc).toEqual([sampleW4Inputs({ current_withholding_per_paycheck_cents: null })]);
    expect(within(result()).queryByRole('group', { name: 'If you change nothing' })).toBeNull();
    expect(result()).toHaveTextContent(
      'Your pay stub is on a different pay schedule from your plan details, so the card cannot say what it withholds over the year.',
    );
    expect(result()).toHaveTextContent('A $0.08 refund at tax time');
  });

  it('keeps a saved decision saved when a newer stub withholds what its entries do', async () => {
    otherDecisionsSaved();
    savedW4();
    db.payStubs = db.payStubs.map((stub) => ({
      ...stub,
      federal_withholding_cents: 21_367,
      net_cents: stub.net_cents + 8_409,
    }));
    const seen = requests();
    await renderReady();
    expect(seen.calc).toEqual([sampleW4Inputs({ current_withholding_per_paycheck_cents: 21_367 })]);
    expect(unchanged()).toHaveTextContent('A $0.08 refund at tax time');
    expect(saveButton()).toHaveTextContent('Saved as v1');
    expect(within(card()).getByText('Saved v1 · Oct 17')).toBeInTheDocument();
  });

  it('keeps a decision saved before the comparison saved, and saves the stub with the next one', async () => {
    otherDecisionsSaved();
    const { current_withholding_per_paycheck_cents: _current, ...older } = sampleW4().inputs;
    db.decisions.push(sampleW4Decision({ inputs: { ...older } }));
    const seen = requests();
    await renderReady();
    expect(saveButton()).toHaveTextContent('Saved as v1');

    type(STEP_4C, '100');
    await recalculated('A $2,400.08 refund');
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveButton()).toHaveTextContent('Saved as v2'));
    expect(seen.save[0]).toMatchObject({
      inputs: sampleW4Inputs({ extra_withholding_cents: 10_000 }),
    });
  });
});

describe('W4Card suggestion', () => {
  it('lowers Step 4(c) when it over-withholds, filling in the suggested entry', async () => {
    otherDecisionsSaved();
    const seen = requests();
    const { user } = await renderReady();
    type(STEP_4C, '100');
    await recalculated('A $2,400.08 refund');
    expect(suggestion()).toHaveTextContent(
      'Lower Step 4(c) to $0.00 a paycheck. That brings tax time to a $0.08 refund.',
    );

    await user.click(within(suggestion()!).getByRole('button', { name: 'Apply suggestion' }));
    expect(field(STEP_4C)).toHaveValue('0.00');
    await recalculated('A $0.08 refund at tax time');
    // Back to the first inputs, whose result is cached: nothing is asked twice.
    expect(seen.calc).toEqual([
      sampleW4().inputs,
      sampleW4Inputs({ extra_withholding_cents: 10_000 }),
    ]);
    expect(suggestion()).toBeNull();
    expect(saveButton()).toBeEnabled();
  });

  it('raises Step 4(c) for a balance due from a second job', async () => {
    otherDecisionsSaved();
    const seen = requests();
    const { user } = await renderReady();
    type("Other jobs' wages a year", '20,000');
    type("Other jobs' withholding a year", '390');
    await recalculated('$3,449.92 due at tax time');
    expect(result()).toHaveTextContent('Refund or balance due$3,449.92 due');
    expect(suggestion()).toHaveTextContent(
      'Enter $144.00 in Step 4(c) to withhold that much more each paycheck. That brings tax time to a $6.08 refund.',
    );

    await user.click(within(suggestion()!).getByRole('button', { name: 'Apply suggestion' }));
    expect(field(STEP_4C)).toHaveValue('144.00');
    await recalculated('A $6.08 refund at tax time');
    expect(seen.calc.at(-1)).toEqual(
      sampleW4Inputs({
        other_jobs_wages_cents: 2_000_000,
        other_jobs_withholding_cents: 39_000,
        extra_withholding_cents: 14_400,
      }),
    );
  });

  it('adds to Step 4(b) when Step 2 is checked with no other job, keeping the expected deductions', async () => {
    otherDecisionsSaved();
    const seen = requests();
    const { user } = await renderReady();
    expect(field(EXPECTED)).toHaveValue('');
    await user.click(within(card()).getByRole('checkbox', { name: /Step 2\(c\)/ }));
    await recalculated('A $3,854.96 refund at tax time');
    expect(result()).toHaveTextContent('Step 2 checkbox schedule, 24% row');
    expect(suggestion()).toHaveTextContent('Enter $17,522.00 in Step 4(b).');

    await user.click(within(suggestion()!).getByRole('button', { name: 'Apply suggestion' }));
    expect(field(STEP_4B)).toHaveValue('17,522.00');
    expect(field(EXPECTED)).toHaveValue('0.00');
    await recalculated('A $0.08 refund at tax time');
    expect(seen.calc.at(-1)).toEqual(
      sampleW4Inputs({
        multiple_jobs: true,
        deductions_cents: 1_752_200,
        expected_deductions_cents: 0,
      }),
    );
  });
});

describe('W4Card saving', () => {
  it('saves version 1 and shows the reminder to hand the form in', async () => {
    otherDecisionsSaved();
    const seen = requests();
    const { user } = await renderReady();
    expect(within(card()).getByText('Not saved')).toBeInTheDocument();
    await user.click(saveButton());
    await waitFor(() => expect(saveButton()).toHaveTextContent('Saved as v1'));
    const { inputs, result: computed } = sampleW4();
    expect(seen.save).toEqual([
      { calculator: 'w4', inputs, result: computed, supersedes_id: null },
    ]);
    expect(
      await within(card()).findByText(
        'Give your employer your updated Form W-4 is on your calendar for Oct 31, 2026.',
      ),
    ).toBeInTheDocument();
    expect(within(card()).getByRole('link', { name: 'Why this decision' })).toHaveAttribute(
      'href',
      `/why/${db.decisions.find((d) => d.calculator === 'w4')!.id}`,
    );
  });

  it('opens on the saved entries and saves the next version when one changes', async () => {
    otherDecisionsSaved();
    savedW4();
    const seen = requests();
    await renderReady();
    expect(saveButton()).toHaveTextContent('Saved as v1');
    expect(within(card()).getByText('Saved v1 · Oct 17')).toBeInTheDocument();
    expect(field(STEP_4C)).toHaveValue('0.00');
    expect(
      within(card()).getByText(
        'Give your employer your updated Form W-4 is on your calendar for Oct 31, 2026.',
      ),
    ).toBeInTheDocument();

    type(STEP_4C, '100');
    await recalculated('A $2,400.08 refund');
    expect(saveButton()).toHaveTextContent('Save as v2');
    expect(within(card()).getByText('Changed since v1')).toBeInTheDocument();
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveButton()).toHaveTextContent('Saved as v2'));
    expect(seen.save[0]).toMatchObject({
      calculator: 'w4',
      supersedes_id: W4_DECISION_ID,
      inputs: sampleW4Inputs({ extra_withholding_cents: 10_000 }),
    });
  });

  it('opens a saved decision on its filing status and Step 2 box', async () => {
    otherDecisionsSaved();
    const saved = sampleW4({
      multiple_jobs: true,
      deductions_cents: 1_752_200,
      expected_deductions_cents: 0,
    });
    db.decisions.push(
      sampleW4Decision({ inputs: { ...saved.inputs }, result: { ...saved.result } }),
    );
    await renderReady();
    expect(saveButton()).toHaveTextContent('Saved as v1');
    expect(within(card()).getByRole('checkbox', { name: /Step 2\(c\)/ })).toBeChecked();
    expect(field(STEP_4B)).toHaveValue('17,522.00');
    expect(field(EXPECTED)).toHaveValue('0.00');
  });

  it('recalculates and asks to save again when the server finds the result out of date', async () => {
    otherDecisionsSaved();
    const seen = requests();
    server.use(
      http.post(
        apiUrl('/decisions'),
        () =>
          HttpResponse.json(
            {
              error: {
                code: 'result_mismatch',
                message: "The result does not match the calculator's result",
                details: { fields: ['withholding_per_paycheck_cents'] },
              },
            },
            { status: 422 },
          ),
        { once: true },
      ),
    );
    const { user } = await renderReady();
    const calcsBefore = seen.calc.length;
    await user.click(saveButton());
    expect(
      await within(card()).findByText(/The calculator's numbers had changed/),
    ).toBeInTheDocument();
    await waitFor(() => expect(seen.calc.length).toBe(calcsBefore + 1));
    await waitFor(() => expect(saveButton()).toBeEnabled());
    await user.click(saveButton());
    await waitFor(() => expect(saveButton()).toHaveTextContent('Saved as v1'));
  });

  it('reloads and offers the next version when another save got there first', async () => {
    otherDecisionsSaved();
    savedW4();
    const { user } = await renderReady();
    db.decisions.push(
      sampleW4Decision({
        id: 'dec00000-0000-4000-8000-0000000000f2',
        version: 2,
        supersedes_id: W4_DECISION_ID,
      }),
    );
    type(STEP_4C, '100');
    await recalculated('A $2,400.08 refund');
    await user.click(saveButton());
    expect(await within(card()).findByText(/saved somewhere else/)).toBeInTheDocument();
    await waitFor(() => expect(saveButton()).toHaveTextContent('Save as v3'));
  });
});

describe('W4Card before it can calculate', () => {
  it('shows what the calculator refused', async () => {
    otherDecisionsSaved();
    server.use(
      http.post(apiUrl('/calc/w4'), () =>
        HttpResponse.json(
          {
            error: {
              code: 'validation_error',
              message: 'The 401(k) deferral and premiums are more than the salary',
            },
          },
          { status: 422 },
        ),
      ),
    );
    renderCard();
    await within(await screen.findByRole('region', { name: TITLE })).findByRole('group', {
      name: 'Filing status',
    });
    await settle();
    expect(await within(result()).findByRole('alert')).toHaveTextContent(
      'The 401(k) deferral and premiums are more than the salary',
    );
    expect(saveButton()).toBeDisabled();
  });

  it('sends a person without a confirmed pay stub to confirm one', async () => {
    renderCard();
    const region = await screen.findByRole('region', { name: TITLE });
    expect(
      await within(region).findByRole('link', { name: 'Confirm your pay stub' }),
    ).toHaveAttribute('href', '/setup/confirm');
  });

  it('asks for the salary on the 401(k) card when the profile has none', async () => {
    decisionsReady();
    db.profile = { ...db.profile, salary_cents: null };
    renderCard();
    const region = await screen.findByRole('region', { name: TITLE });
    expect(await within(region).findByText(/needs your salary/)).toBeInTheDocument();
  });
});
