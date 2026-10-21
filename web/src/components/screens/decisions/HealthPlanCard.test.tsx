import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CALC_DEBOUNCE_MS } from '@/lib/api/hooks';
import {
  BRONZE_HSA,
  GOLD_PPO,
  HEALTH_DECISION_ID,
  sampleBenefitsPlans,
  sampleHealthDecision,
  sampleHealthPlans,
  sampleHealthPlansInputs,
  SILVER_HMO,
} from '@/test/fixtures/planning';
import { SAMPLE_NOW } from '@/test/fixtures/sample';
import { db, decisionsReady } from '@/test/msw/db';
import { apiUrl } from '@/test/msw/handlers';
import { benefitsConfirmed, planningDb, savedHealthPlan } from '@/test/msw/planning-handlers';
import { server } from '@/test/msw/server';
import { act, fireEvent, renderWithProviders, screen, waitFor, within } from '@/test/render';
import { HealthPlanCard } from './HealthPlanCard';

/** Request bodies by route, in order. */
function requests() {
  const seen = {
    calc: [] as Record<string, unknown>[],
    calcAt: [] as number[],
    save: [] as Record<string, unknown>[],
  };
  server.events.on('request:start', async ({ request }) => {
    const path = new URL(request.url).pathname;
    if (path === '/calc/health-plans') {
      seen.calcAt.push(Date.now());
      seen.calc.push(await request.clone().json());
    }
    if (path === '/decisions' && request.method === 'POST') {
      seen.save.push(await request.clone().json());
    }
  });
  return seen;
}

const card = () => screen.getByRole('region', { name: 'Health plan' });
const result = () => within(card()).getByRole('group', { name: 'Calculator result' });
const usage = () => within(card()).getByRole('group', { name: 'Expected healthcare use' });
const choice = () => within(card()).getByRole('group', { name: 'The plan you will enroll in' });
const table = () => within(card()).getByRole('table', { name: 'Expected yearly cost by plan' });
const saveButton = () => within(card()).getByRole('button', { name: /^Save|^Saved/ });
const settle = () => act(() => vi.advanceTimersByTimeAsync(CALC_DEBOUNCE_MS));

function renderCard() {
  return renderWithProviders(<HealthPlanCard />, { advanceTimers: vi.advanceTimersByTime });
}

/** Rendered with the comparison in place. */
async function renderReady() {
  const rendered = renderCard();
  await within(await screen.findByRole('region', { name: 'Health plan' })).findByRole('group', {
    name: 'Expected healthcare use',
  });
  await settle();
  await waitFor(() => expect(result()).toHaveTextContent('costs the least'));
  await waitFor(() => expect(result()).not.toHaveAttribute('aria-busy', 'true'));
  return rendered;
}

/** The table's rows as [row header, ...cells]. */
const rows = () =>
  within(table())
    .getAllByRole('row')
    .map((row) => Array.from(row.querySelectorAll('th, td'), (cell) => cell.textContent));

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(SAMPLE_NOW) }));
afterEach(() => {
  vi.useRealTimers();
  server.events.removeAllListeners();
});

describe('HealthPlanCard from a confirmed benefits summary', () => {
  it('compares the summary plans at the expected use, with the cheapest marked', async () => {
    decisionsReady();
    benefitsConfirmed();
    const seen = requests();
    await renderReady();

    expect(card()).toHaveTextContent(
      '2 plans from your benefits summary. Enrollment closes Nov 14, 2026.',
    );
    expect(seen.calc).toEqual([sampleHealthPlans().inputs]);
    expect(within(usage()).getByRole('button', { name: 'Medium · about $3,000' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(result()).toHaveTextContent('Gold PPO costs the least at medium use: $2,025 a year');
    expect(rows()).toEqual([
      ['', 'Bronze HSAHigh deductible (HDHP)', 'Gold PPOPPOCheapest at medium use'],
      ['Premium per year', '$750', '$1,500'],
      ['Deductible', '$1,800', '$250'],
      ['Coinsurance', '20%', '10%'],
      ['Out-of-pocket maximum', '$3,500', '$3,000'],
      ['Employer HSA money', '$600', 'None'],
      ['Your HSA tax savings', '$0', 'No HSA'],
      ['Low use · about $500', '$650', '$1,775'],
      ['Medium use · about $3,000', '$2,190', '$2,025'],
      ['High use · about $10,000', '$3,590', '$2,725'],
      ['Worst case', '$3,650', '$4,500'],
    ]);
    expect(
      within(result()).getByText(/The cheaper plan changes at \$1,800 and \$19,300/),
    ).toBeInTheDocument();
    expect(result()).toHaveTextContent('Bronze HSA lets you put money into an HSA before tax.');
    // Nothing is chosen yet, so nothing can be saved.
    expect(
      within(choice())
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-pressed')),
    ).toEqual(['false', 'false']);
    expect(saveButton()).toBeDisabled();
    expect(card()).toHaveTextContent('Choose the plan you will enroll in to save.');
    expect(within(card()).getByLabelText('Enrollment deadline')).toHaveValue('2026-11-14');
  });

  it('sends one request when the usage changes and measures the debounce', async () => {
    decisionsReady();
    benefitsConfirmed();
    const seen = requests();
    const { user } = await renderReady();
    await user.click(within(usage()).getByRole('button', { name: 'High · about $10,000' }));
    const stoppedAt = Date.now();
    expect(result()).toHaveAttribute('aria-busy', 'true');
    await settle();
    await waitFor(() => expect(result()).toHaveTextContent('Gold PPO costs the least at high use'));
    expect(seen.calc.map((body) => body.expected_usage)).toEqual(['medium', 'high']);
    expect(seen.calcAt[1]! - stoppedAt).toBeGreaterThanOrEqual(CALC_DEBOUNCE_MS);
  });

  it('shows what an HSA contribution saves, and when the limit caps it', async () => {
    decisionsReady();
    benefitsConfirmed();
    await renderReady();
    fireEvent.change(within(card()).getByLabelText('Your own HSA contribution this year'), {
      target: { value: '1,000' },
    });
    await settle();
    await waitFor(() =>
      expect(result()).toHaveTextContent(
        'With Bronze HSA, putting $1,000.00 into your HSA saves $120.00 in federal income tax at your 12% marginal rate.',
      ),
    );

    fireEvent.change(within(card()).getByLabelText('Your own HSA contribution this year'), {
      target: { value: '5,000' },
    });
    await settle();
    await waitFor(() => expect(result()).toHaveTextContent('capped at $3,800.00'));
    expect(result()).toHaveTextContent('Bronze HSA costs the least at medium use');
  });

  it('warns about a plan labeled high-deductible that misses the HSA rules', async () => {
    decisionsReady();
    planningDb.benefitsPlans = sampleBenefitsPlans.map((plan) =>
      plan.kind === 'hdhp' ? { ...plan, deductible_cents: 150_000 } : { ...plan },
    );
    renderCard();
    // The results fixture has this plan only with a $1,000 HSA contribution.
    await within(await screen.findByRole('region', { name: 'Health plan' })).findByRole('group', {
      name: 'Expected healthcare use',
    });
    fireEvent.change(within(card()).getByLabelText('Your own HSA contribution this year'), {
      target: { value: '1,000' },
    });
    await settle();
    await waitFor(() =>
      expect(within(card()).getByText(/is labeled a high-deductible plan/)).toHaveTextContent(
        'Bronze HSA is labeled a high-deductible plan but does not meet the 2026 HSA rules',
      ),
    );
  });
});

describe('HealthPlanCard saving', () => {
  it('saves the chosen plan with the deadline, and says the deadline is on the calendar', async () => {
    decisionsReady();
    benefitsConfirmed();
    const seen = requests();
    const { user } = await renderReady();
    await user.click(within(choice()).getByRole('button', { name: 'Bronze HSA' }));
    await settle();
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(within(table()).getAllByText('Your choice')).toHaveLength(1);

    await user.click(saveButton());
    await waitFor(() => expect(saveButton()).toHaveTextContent('Saved as v1'));
    const { inputs, result: computed } = sampleHealthPlans({ selected_plan_index: 0 });
    expect(seen.save).toEqual([
      { calculator: 'health_plans', inputs, result: computed, supersedes_id: null },
    ]);
    expect(
      await within(card()).findByText(
        'Health plan enrollment deadline is on your calendar for Nov 14, 2026.',
      ),
    ).toBeInTheDocument();
    expect(within(card()).getByRole('link', { name: 'Why this decision' })).toHaveAttribute(
      'href',
      `/why/${db.decisions[0]!.id}`,
    );
  });

  it('opens on the saved choice and saves the next version when it changes', async () => {
    decisionsReady();
    benefitsConfirmed();
    savedHealthPlan();
    const seen = requests();
    const { user } = await renderReady();
    expect(within(choice()).getByRole('button', { name: 'Gold PPO' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(saveButton()).toHaveTextContent('Saved as v1');

    await user.click(within(choice()).getByRole('button', { name: 'Bronze HSA' }));
    await settle();
    await waitFor(() => expect(saveButton()).toHaveTextContent('Save as v2'));
    await user.click(saveButton());
    await waitFor(() => expect(saveButton()).toHaveTextContent('Saved as v2'));
    expect(seen.save[0]).toMatchObject({
      supersedes_id: HEALTH_DECISION_ID,
      inputs: sampleHealthPlansInputs({ selected_plan_index: 0 }),
    });
  });

  it('recalculates and asks to save again when the server finds the result out of date', async () => {
    decisionsReady();
    benefitsConfirmed();
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
                details: { fields: ['plans'] },
              },
            },
            { status: 422 },
          ),
        { once: true },
      ),
    );
    const { user } = await renderReady();
    await user.click(within(choice()).getByRole('button', { name: 'Gold PPO' }));
    await settle();
    await waitFor(() => expect(saveButton()).toBeEnabled());
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
    decisionsReady();
    benefitsConfirmed();
    savedHealthPlan();
    const { user } = await renderReady();
    db.decisions.push(
      sampleHealthDecision({
        id: 'dec00000-0000-4000-8000-0000000000c2',
        version: 2,
        supersedes_id: HEALTH_DECISION_ID,
      }),
    );
    await user.click(within(choice()).getByRole('button', { name: 'Bronze HSA' }));
    await settle();
    await waitFor(() => expect(saveButton()).toHaveTextContent('Save as v2'));
    await user.click(saveButton());
    expect(await within(card()).findByText(/saved somewhere else/)).toBeInTheDocument();
    await waitFor(() => expect(saveButton()).toHaveTextContent('Save as v3'));
  });
});

describe('HealthPlanCard without a benefits summary', () => {
  it('compares plans typed by hand, then saves the one chosen', async () => {
    decisionsReady();
    const seen = requests();
    const { user } = renderCard();
    const form = await within(
      await screen.findByRole('region', { name: 'Health plan' }),
    ).findByRole('form', { name: 'Your health plan options' });
    expect(card()).toHaveTextContent('No benefits summary is confirmed');

    const plan = within(form).getByRole('group', { name: 'Plan 1' });
    await user.type(within(plan).getByLabelText('Plan name'), 'Silver HMO');
    await user.selectOptions(within(plan).getByLabelText('Plan type'), 'hmo');
    expect(within(plan).queryByLabelText('Employer HSA money per year')).toBeNull();
    await user.type(within(plan).getByLabelText('Premium per paycheck'), '40');
    await user.type(within(plan).getByLabelText('Deductible'), '1,000');
    await user.type(within(plan).getByLabelText('Coinsurance, %'), '0');
    await user.type(within(plan).getByLabelText('Out-of-pocket maximum'), '2,500');
    await user.click(within(form).getByRole('button', { name: 'Compare these plans' }));

    await settle();
    await waitFor(() => expect(result()).toHaveTextContent('Silver HMO costs the least'));
    expect(seen.calc[0]).toEqual(
      sampleHealthPlansInputs({ plans: [SILVER_HMO], enrollment_deadline: null }),
    );
    await user.click(within(choice()).getByRole('button', { name: 'Silver HMO' }));
    await settle();
    await waitFor(() => expect(saveButton()).toBeEnabled());
    await user.click(saveButton());
    await waitFor(() => expect(saveButton()).toHaveTextContent('Saved as v1'));
  });

  it('says what to fix in a typed plan, and allows up to eight', async () => {
    decisionsReady();
    const seen = requests();
    const { user } = renderCard();
    const form = await within(
      await screen.findByRole('region', { name: 'Health plan' }),
    ).findByRole('form', { name: 'Your health plan options' });
    await user.click(within(form).getByRole('button', { name: 'Compare these plans' }));
    expect(within(form).getByLabelText('Plan name')).toHaveAccessibleDescription(
      'Enter the plan name.',
    );
    expect(seen.calc).toEqual([]);

    for (let i = 1; i < 8; i += 1) {
      await user.click(within(form).getByRole('button', { name: 'Add a plan' }));
    }
    expect(within(form).getAllByRole('group', { name: /^Plan \d$/ })).toHaveLength(8);
    expect(within(form).queryByRole('button', { name: 'Add a plan' })).toBeNull();
    await user.click(within(form).getByRole('button', { name: 'Remove plan 8' }));
    expect(within(form).getAllByRole('group', { name: /^Plan \d$/ })).toHaveLength(7);
  });

  it('edits the compared plans, starting from what is on screen', async () => {
    decisionsReady();
    benefitsConfirmed();
    const { user } = await renderReady();
    await user.click(within(card()).getByRole('button', { name: 'Edit plans' }));
    const form = within(card()).getByRole('form', { name: 'Your health plan options' });
    expect(
      within(form)
        .getAllByLabelText('Plan name')
        .map((input) => (input as HTMLInputElement).value),
    ).toEqual([BRONZE_HSA.name, GOLD_PPO.name]);
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(within(card()).queryByRole('form', { name: 'Your health plan options' })).toBeNull();
  });
});

describe('HealthPlanCard before it can compare', () => {
  it('sends a person without a confirmed pay stub to confirm one', async () => {
    renderCard();
    const region = await screen.findByRole('region', { name: 'Health plan' });
    expect(
      await within(region).findByRole('link', { name: 'Confirm your pay stub' }),
    ).toHaveAttribute('href', '/setup/confirm');
  });

  it('asks for the salary and filing status the tax effect needs', async () => {
    decisionsReady();
    db.profile = { ...db.profile, salary_cents: null };
    renderCard();
    const region = await screen.findByRole('region', { name: 'Health plan' });
    expect(
      await within(region).findByText(/needs your salary and filing status/),
    ).toBeInTheDocument();
  });
});
