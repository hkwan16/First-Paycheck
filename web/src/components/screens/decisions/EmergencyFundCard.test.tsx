import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CALC_DEBOUNCE_MS } from '@/lib/api/hooks';
import { parseMoney } from '@/lib/money';
import {
  EMERGENCY_DECISION_ID,
  GOAL_ID,
  sampleEmergencyDecision,
  sampleEmergencyFund,
} from '@/test/fixtures/planning';
import { SAMPLE_NOW } from '@/test/fixtures/sample';
import { db, decisionsReady } from '@/test/msw/db';
import { apiUrl } from '@/test/msw/handlers';
import { planningDb, savedEmergencyFund } from '@/test/msw/planning-handlers';
import { server } from '@/test/msw/server';
import { spendingDb } from '@/test/msw/spending-handlers';
import { act, fireEvent, renderWithProviders, screen, waitFor, within } from '@/test/render';
import { EmergencyFundCard } from './EmergencyFundCard';

/** Request bodies by route, in order. */
function requests() {
  const seen = {
    calc: [] as Record<string, unknown>[],
    /** When each calculator request left, on the test clock. */
    calcAt: [] as number[],
    save: [] as Record<string, unknown>[],
    goal: [] as Record<string, unknown>[],
  };
  server.events.on('request:start', async ({ request }) => {
    const path = new URL(request.url).pathname;
    if (path === '/calc/emergency-fund') {
      seen.calcAt.push(Date.now());
      seen.calc.push(await request.clone().json());
    }
    if (path === '/decisions' && request.method === 'POST') {
      seen.save.push(await request.clone().json());
    }
    if (path.startsWith('/goals/')) seen.goal.push(await request.clone().json());
  });
  return seen;
}

const card = () => screen.getByRole('region', { name: 'Emergency fund' });
const result = () => within(card()).getByRole('group', { name: 'Calculator result' });
const months = () => within(card()).getByRole('slider', { name: /Months of essentials/ });
const field = (name: string | RegExp) => within(card()).getByLabelText(name);
const saveButton = () => within(card()).getByRole('button', { name: /^Save|^Saved/ });
const goal = () => within(card()).getByRole('group', { name: 'Your emergency fund goal' });
const settle = () => act(() => vi.advanceTimersByTimeAsync(CALC_DEBOUNCE_MS));

/** A whole amount at once, as a paste would, so no half-typed value is ever sent. */
const enter = (name: string | RegExp, text: string) =>
  fireEvent.change(field(name), { target: { value: text } });

function renderCard() {
  return renderWithProviders(<EmergencyFundCard />, { advanceTimers: vi.advanceTimersByTime });
}

async function renderLoaded() {
  const rendered = renderCard();
  await within(await screen.findByRole('region', { name: 'Emergency fund' })).findByRole('slider');
  return rendered;
}

/** Rendered with a result in place. */
async function renderReady() {
  const rendered = await renderLoaded();
  await settle();
  await waitFor(() => expect(result()).toHaveTextContent('Target'));
  await waitFor(() => expect(result()).not.toHaveAttribute('aria-busy', 'true'));
  return rendered;
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(SAMPLE_NOW) }));
afterEach(() => {
  vi.useRealTimers();
  server.events.removeAllListeners();
});

describe('EmergencyFundCard before a decision', () => {
  it('starts from the spending summary and the emergency fund account, and asks for an amount', async () => {
    decisionsReady();
    const seen = requests();
    await renderLoaded();
    expect(field('Essential spending per month')).toHaveValue('1,823.25');
    expect(field('Essential spending per month')).toHaveAccessibleDescription(
      'From your spending, Oct 1 to Oct 17, 2026. Change it if a usual month runs higher.',
    );
    expect(months()).toHaveValue('3');
    expect(months()).toHaveAttribute('aria-valuetext', '3 months');
    expect(field('Saved so far')).toHaveValue('2,140.00');
    expect(field('Saved so far')).toHaveAccessibleDescription(
      'The balance of Chase Savings ··7730, your emergency fund account.',
    );
    // Nothing on hand says what the person will move each month, so the field
    // starts empty, and its placeholder reads as an example, not a value.
    const transfer = field('Monthly transfer to savings');
    expect(transfer).toHaveValue('');
    expect(transfer).toHaveAttribute('placeholder', 'for example 300.00');
    expect(parseMoney(transfer.getAttribute('placeholder') ?? '')).toBeNull();
    expect(result()).toHaveTextContent('Enter a monthly transfer to see your numbers.');
    expect(within(card()).getByText('Not saved')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();

    enter('Monthly transfer to savings', '300');
    await settle();
    await waitFor(() => expect(result()).toHaveTextContent('Target $5,470, reached in 12 months'));
    expect(seen.calc).toEqual([sampleEmergencyFund().inputs]);
    expect(
      within(result()).getByRole('progressbar', { name: 'Emergency fund progress' }),
    ).toHaveAttribute('aria-valuenow', '39.12');
    const rows = within(result())
      .getAllByRole('term')
      .map((term) => [term.textContent, term.nextElementSibling?.textContent]);
    expect(rows).toEqual([
      ['Target, 3 months of essentials', '$5,469.75'],
      ['Suggested range, 3 to 6 months', '$5,469.75 to $10,939.50'],
      ['Already saved', '39.12% of the target'],
      ['Still to save', '$3,329.75'],
      ['Months to reach it', '12 months'],
      ['Per paycheck, 24 a year', '$150.00'],
    ]);
    expect(saveButton()).toBeEnabled();
  });

  it('says when the transfer never gets there within the horizon', async () => {
    decisionsReady();
    await renderLoaded();
    enter('Monthly transfer to savings', '10');
    await settle();
    await waitFor(() =>
      expect(result()).toHaveTextContent('Target $5,470, not within 10 years at this amount'),
    );
    expect(within(result()).getByText('Not within 10 years')).toBeInTheDocument();
  });

  it('sends the essentials and savings as typed, in cents', async () => {
    decisionsReady();
    const seen = requests();
    await renderLoaded();
    enter('Monthly transfer to savings', '300');
    enter('Essential spending per month', '2,000');
    await settle();
    await waitFor(() => expect(seen.calc).toHaveLength(1));
    expect(seen.calc[0]).toEqual(sampleEmergencyFund({ monthly_essentials_cents: 200_000 }).inputs);

    enter('Essential spending per month', '1,823.25');
    enter('Saved so far', '$6,000');
    await settle();
    await waitFor(() =>
      expect(result()).toHaveTextContent('Your savings already cover the $5,470 target'),
    );
    expect(within(result()).getByText('Already there')).toBeInTheDocument();
  });

  it('says what to fix in an amount and sends nothing until it reads', async () => {
    decisionsReady();
    const seen = requests();
    await renderLoaded();
    enter('Monthly transfer to savings', '300');
    enter('Essential spending per month', 'a lot');
    await settle();
    expect(field('Essential spending per month')).toHaveAccessibleDescription(
      'Enter an amount above $0, like 1,823.25.',
    );
    expect(result()).toHaveTextContent('Enter your essential spending to see your numbers.');
    expect(seen.calc).toEqual([]);
  });

  it('asks for the savings when no account is the emergency fund, and starts empty without spending', async () => {
    decisionsReady();
    db.accounts = db.accounts.map((a) => ({
      ...a,
      role: a.role === 'emergency_fund' ? null : a.role,
    }));
    spendingDb.cashflow.spending.essentials_cents = 0;
    const seen = requests();
    await renderLoaded();
    expect(field('Saved so far')).toHaveValue('');
    expect(field('Saved so far')).toHaveAccessibleDescription(
      'No account is marked as your emergency fund, so enter what you have set aside.',
    );
    expect(field('Essential spending per month')).toHaveValue('');

    enter('Essential spending per month', '1,823.25');
    enter('Saved so far', '0');
    enter('Monthly transfer to savings', '300');
    await settle();
    await waitFor(() => expect(seen.calc).toHaveLength(1));
    expect(seen.calc[0]).toEqual(sampleEmergencyFund({ current_balance_cents: 0 }).inputs);
  });

  it('sends one request after the target slider settles, keeping the last numbers meanwhile', async () => {
    decisionsReady();
    const seen = requests();
    await renderLoaded();
    enter('Monthly transfer to savings', '300');
    await settle();
    await waitFor(() => expect(result()).toHaveTextContent('reached in 12 months'));
    expect(seen.calc).toHaveLength(1);

    fireEvent.change(months(), { target: { value: '4' } });
    fireEvent.change(months(), { target: { value: '5' } });
    fireEvent.change(months(), { target: { value: '6' } });
    const stoppedAt = Date.now();
    expect(result()).toHaveAttribute('aria-busy', 'true');
    expect(result()).toHaveTextContent('reached in 12 months');
    expect(saveButton()).toBeDisabled();

    await settle();
    await waitFor(() => expect(result()).not.toHaveAttribute('aria-busy', 'true'));
    expect(seen.calc.map((body) => body.target_months)).toEqual([3, 6]);
    expect(seen.calcAt[1]! - stoppedAt).toBeGreaterThanOrEqual(CALC_DEBOUNCE_MS);
    expect(result()).toHaveTextContent('Target $10,940, reached in 30 months');
  });

  it('sends a person without a pay schedule to confirm a pay stub', async () => {
    renderCard();
    const region = await screen.findByRole('region', { name: 'Emergency fund' });
    expect(
      await within(region).findByRole('link', { name: 'Confirm your pay stub' }),
    ).toHaveAttribute('href', '/setup/confirm');
  });
});

describe('EmergencyFundCard saving', () => {
  it('saves v1 with the calculator result, then shows the goal it made', async () => {
    decisionsReady();
    const seen = requests();
    const { user } = await renderLoaded();
    enter('Monthly transfer to savings', '300');
    await settle();
    await waitFor(() => expect(saveButton()).toBeEnabled());

    await user.click(saveButton());
    await waitFor(() => expect(saveButton()).toHaveTextContent('Saved as v1'));
    const { inputs, result: computed } = sampleEmergencyFund();
    expect(seen.save).toEqual([
      { calculator: 'emergency_fund', inputs, result: computed, supersedes_id: null },
    ]);
    expect(within(card()).getByText('Saved v1 · Oct 17')).toBeInTheDocument();
    // Explaining an emergency fund decision is not available yet (spec 011).
    expect(within(card()).queryByRole('link', { name: 'Why this decision' })).toBeNull();

    expect(
      await within(card()).findByRole('group', { name: 'Your emergency fund goal' }),
    ).toBeInTheDocument();
    expect(goal()).toHaveTextContent('Active');
    expect(goal()).toHaveTextContent('$300.00 a month toward $5,469.75');
    expect(goal()).toHaveTextContent('On pace to reach it by Sep 30, 2027');
    expect(goal()).toHaveTextContent('$2,140.00 in Chase Savings ··7730');
  });

  it('opens on the saved decision and saves the next version over it', async () => {
    decisionsReady();
    savedEmergencyFund();
    const seen = requests();
    const { user } = await renderReady();
    expect(field('Monthly transfer to savings')).toHaveValue('300.00');
    expect(saveButton()).toHaveTextContent('Saved as v1');
    expect(saveButton()).toHaveAttribute('aria-pressed', 'true');

    enter('Monthly transfer to savings', '500');
    await settle();
    await waitFor(() => expect(saveButton()).toHaveTextContent('Save as v2'));
    expect(within(card()).getByText('Changed since v1')).toBeInTheDocument();
    await user.click(saveButton());
    await waitFor(() => expect(saveButton()).toHaveTextContent('Saved as v2'));
    expect(seen.save[0]).toMatchObject({
      supersedes_id: EMERGENCY_DECISION_ID,
      inputs: sampleEmergencyFund({ monthly_contribution_cents: 50_000 }).inputs,
    });
    await waitFor(() => expect(goal()).toHaveTextContent('$500.00 a month toward $5,469.75'));
    expect(planningDb.goals).toHaveLength(1);
  });

  it('recalculates and asks to save again when the server finds the result out of date', async () => {
    decisionsReady();
    savedEmergencyFund();
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
                details: { fields: ['months_to_target'] },
              },
            },
            { status: 422 },
          ),
        { once: true },
      ),
    );
    const { user } = await renderReady();
    enter('Monthly transfer to savings', '500');
    await settle();
    await waitFor(() => expect(saveButton()).toBeEnabled());
    const calcsBefore = seen.calc.length;

    await user.click(saveButton());
    expect(
      await within(card()).findByText(/The calculator's numbers had changed/),
    ).toBeInTheDocument();
    await waitFor(() => expect(seen.calc.length).toBe(calcsBefore + 1));
    expect(db.decisions).toHaveLength(1);

    await waitFor(() => expect(saveButton()).toBeEnabled());
    await user.click(saveButton());
    await waitFor(() => expect(saveButton()).toHaveTextContent('Saved as v2'));
  });

  it('reloads and offers the next version when another save got there first', async () => {
    decisionsReady();
    savedEmergencyFund();
    const { user } = await renderReady();
    db.decisions.push(
      sampleEmergencyDecision({
        id: 'dec00000-0000-4000-8000-0000000000e2',
        version: 2,
        supersedes_id: EMERGENCY_DECISION_ID,
      }),
    );
    enter('Monthly transfer to savings', '500');
    await settle();
    await waitFor(() => expect(saveButton()).toHaveTextContent('Save as v2'));

    await user.click(saveButton());
    expect(await within(card()).findByText(/saved somewhere else/)).toBeInTheDocument();
    await waitFor(() => expect(saveButton()).toHaveTextContent('Save as v3'));
  });
});

describe('EmergencyFundCard goal', () => {
  async function renderWithGoal() {
    decisionsReady();
    savedEmergencyFund();
    const rendered = await renderReady();
    await within(card()).findByRole('group', { name: 'Your emergency fund goal' });
    return rendered;
  }

  it('pauses and resumes the goal', async () => {
    const seen = requests();
    const { user } = await renderWithGoal();
    await user.click(within(goal()).getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(goal()).toHaveTextContent('Paused'));
    expect(seen.goal).toEqual([{ status: 'paused' }]);
    // A paused goal is on pace for nothing (issue 166).
    expect(goal()).toHaveTextContent('No projected date while it is paused.');
    expect(goal()).not.toHaveTextContent('On pace');

    await user.click(within(goal()).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(goal()).toHaveTextContent('Active'));
    expect(seen.goal[1]).toEqual({ status: 'active' });
  });

  it('marks the goal reached, and can take that back', async () => {
    const { user } = await renderWithGoal();
    await user.click(within(goal()).getByRole('button', { name: 'Mark reached' }));
    await waitFor(() => expect(goal()).toHaveTextContent('Reached on Oct 17, 2026'));
    expect(within(goal()).queryByRole('button', { name: 'Pause' })).toBeNull();
    await user.click(within(goal()).getByRole('button', { name: 'Not reached yet' }));
    await waitFor(() => expect(goal()).toHaveTextContent('Active'));
  });

  it('changes the monthly contribution, which projects the date again and shows on the card', async () => {
    // Spec 011 rules 17a and 17b (issue 165).
    const seen = requests();
    const { user } = await renderWithGoal();
    await user.click(within(goal()).getByRole('button', { name: 'Change contribution' }));
    const input = within(goal()).getByLabelText('New monthly contribution');
    expect(input).toHaveValue('300.00');
    await user.clear(input);
    await user.type(input, '500');
    await user.click(within(goal()).getByRole('button', { name: 'Save contribution' }));

    await waitFor(() => expect(goal()).toHaveTextContent('$500.00 a month toward $5,469.75'));
    expect(seen.goal).toEqual([{ monthly_contribution_cents: 50_000 }]);
    expect(goal()).toHaveTextContent('On pace to reach it by Apr 30, 2027.');
    expect(within(goal()).queryByLabelText('New monthly contribution')).toBeNull();

    // The card shows the goal's amount, and that the saved decision has another.
    const transfer = field('Monthly transfer to savings');
    expect(transfer).toHaveValue('500.00');
    expect(transfer).toHaveAccessibleDescription(
      'From your goal. Your saved decision, v1, has $300.00 a month.',
    );
    await settle();
    await waitFor(() => expect(result()).toHaveTextContent('reached in 7 months'));
    await waitFor(() => expect(saveButton()).toHaveTextContent('Save as v2'));

    // Back at the saved amount, the goal has its date again and the card is saved.
    await user.click(within(goal()).getByRole('button', { name: 'Change contribution' }));
    const again = within(goal()).getByLabelText('New monthly contribution');
    await user.clear(again);
    await user.type(again, '300');
    await user.click(within(goal()).getByRole('button', { name: 'Save contribution' }));
    await waitFor(() => expect(goal()).toHaveTextContent('On pace to reach it by Sep 30, 2027.'));
    await waitFor(() => expect(saveButton()).toHaveTextContent('Saved as v1'));
    expect(field('Monthly transfer to savings')).toHaveValue('300.00');
  });

  it("saves the goal's contribution as the next version", async () => {
    const seen = requests();
    decisionsReady();
    savedEmergencyFund();
    planningDb.goals[0] = { ...planningDb.goals[0]!, monthly_contribution_cents: 50_000 };
    const { user } = await renderReady();
    await waitFor(() => expect(saveButton()).toHaveTextContent('Save as v2'));
    await user.click(saveButton());
    await waitFor(() => expect(saveButton()).toHaveTextContent('Saved as v2'));
    expect(seen.save[0]).toMatchObject({
      supersedes_id: EMERGENCY_DECISION_ID,
      inputs: sampleEmergencyFund({ monthly_contribution_cents: 50_000 }).inputs,
    });
    expect(field('Monthly transfer to savings')).not.toHaveAccessibleDescription(/From your goal/);
  });

  it('says what to fix in a new contribution before sending it', async () => {
    const seen = requests();
    const { user } = await renderWithGoal();
    await user.click(within(goal()).getByRole('button', { name: 'Change contribution' }));
    const input = within(goal()).getByLabelText('New monthly contribution');
    await user.clear(input);
    await user.type(input, 'more');
    await user.click(within(goal()).getByRole('button', { name: 'Save contribution' }));
    expect(input).toHaveAccessibleDescription('Enter an amount, like 300.00.');
    expect(seen.goal).toEqual([]);
  });

  it("shows the API's refusal of a goal change", async () => {
    server.use(
      http.patch(apiUrl(`/goals/${GOAL_ID}`), () =>
        HttpResponse.json(
          { error: { code: 'not_found', message: 'Goal not found' } },
          { status: 404 },
        ),
      ),
    );
    const { user } = await renderWithGoal();
    await user.click(within(goal()).getByRole('button', { name: 'Pause' }));
    expect(await within(goal()).findByRole('alert')).toHaveTextContent('Goal not found');
  });
});
