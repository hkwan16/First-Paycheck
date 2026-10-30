import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CALC_DEBOUNCE_MS } from '@/lib/api/hooks';
import { parseMoney } from '@/lib/money';
import {
  cappedK401,
  DECISION_V1_ID,
  sampleDecision,
  sampleK401,
  stub01K401,
} from '@/test/fixtures/decisions';
import {
  emptyProfile,
  SAMPLE_ANNUAL_SALARY_CENTS,
  samplePayStub,
  stub01PayStub,
} from '@/test/fixtures/documents';
import { SAMPLE_NOW } from '@/test/fixtures/sample';
import { db, decisionsReady, savedDecision, stub01Ready } from '@/test/msw/db';
import { apiUrl } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { act, fireEvent, renderWithProviders, screen, waitFor, within } from '@/test/render';
import { Match401kCard } from './Match401kCard';

/** Request bodies by path, in order. */
function requests() {
  const seen = {
    calc: [] as { contribution_pct: string }[],
    /** When each calculator request left, on the test clock. */
    calcAt: [] as number[],
    save: [] as Record<string, unknown>[],
  };
  server.events.on('request:start', async ({ request }) => {
    const path = new URL(request.url).pathname;
    if (path === '/calc/401k-match') {
      seen.calcAt.push(Date.now());
      seen.calc.push(await request.clone().json());
    }
    if (path === '/decisions' && request.method === 'POST') {
      seen.save.push(await request.clone().json());
    }
  });
  return seen;
}

const card = () => screen.getByRole('region', { name: '401(k) match' });
const result = () => within(card()).getByRole('group', { name: 'Calculator result' });
const slider = () => within(card()).getByRole('slider', { name: /Your contribution/ });
const saveButton = () => within(card()).getByRole('button', { name: /^Save|^Saved/ });
const settle = () => act(() => vi.advanceTimersByTimeAsync(CALC_DEBOUNCE_MS));

function renderCard() {
  return renderWithProviders(<Match401kCard />, { advanceTimers: vi.advanceTimersByTime });
}

/** Rendered with its result in place. */
async function renderReady() {
  const rendered = renderCard();
  await within(await screen.findByRole('region', { name: '401(k) match' })).findByRole('slider');
  await settle();
  await waitFor(() => expect(result()).not.toHaveAttribute('aria-busy', 'true'));
  return rendered;
}

const drag = (percent: number) =>
  fireEvent.change(slider(), { target: { value: String(percent) } });

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(SAMPLE_NOW) }));
afterEach(() => {
  vi.useRealTimers();
  server.events.removeAllListeners();
});

describe('Match401kCard with a saved decision', () => {
  it('opens on the saved contribution with the calculator result and the saved state', async () => {
    savedDecision();
    await renderReady();
    expect(card()).toHaveTextContent(
      'Acme Corp matches 100% of the first 4% of your $65,000 salary.',
    );
    expect(card()).toHaveTextContent('Your Oct 15 pay stub shows $0.00 a paycheck');
    expect(slider()).toHaveValue('4');
    expect(slider()).toHaveAttribute('aria-valuetext', '4% of salary');
    // The age comes from the profile's birth year; the card no longer asks for it.
    expect(within(card()).queryByLabelText(/age/i)).not.toBeInTheDocument();

    expect(result()).toHaveTextContent('At 4% you would capture the full $2,600 match');
    const rows = within(result())
      .getAllByRole('term')
      .map((term) => [term.textContent, term.nextElementSibling?.textContent]);
    expect(rows).toEqual([
      ['Contribution for the full match', '4% of salary'],
      ['You put in per year', '$2,600'],
      ['Acme Corp adds per year', '$2,600'],
      ['Acme Corp adds at the full match', '$2,600'],
      ['Match you miss per year', '$0'],
      ['Extra per paycheck for the full match, before tax', '$0.00'],
      ['Extra per paycheck, after federal tax at 12% marginal', '$0.00'],
    ]);

    expect(within(card()).getByText('Saved v1 · Oct 17')).toBeInTheDocument();
    expect(saveButton()).toHaveTextContent('Saved as v1');
    expect(saveButton()).toHaveAttribute('aria-pressed', 'true');
    expect(within(card()).getByRole('link', { name: 'Why this decision' })).toHaveAttribute(
      'href',
      `/why/${DECISION_V1_ID}`,
    );
  });

  it('shows the 402(g) and compensation limit notices when the result says they bind', async () => {
    decisionsReady();
    db.profile = {
      ...db.profile,
      salary_cents: cappedK401.inputs.salary_cents,
      pay_frequency: 'biweekly',
      match_tiers: [
        { employee_pct_upto: '3.00', employer_pct: '100.00' },
        { employee_pct_upto: '5.00', employer_pct: '50.00' },
      ],
    };
    db.decisions = [
      sampleDecision({ inputs: { ...cappedK401.inputs }, result: { ...cappedK401.result } }),
    ];
    await renderReady();
    expect(card()).toHaveTextContent('100% of the first 3%, then 50% up to 5%');
    expect(result()).toHaveTextContent('At 6% you would capture the full $14,400 match');
    expect(within(card()).getByText(/Over the 2026 limit/)).toBeInTheDocument();
    expect(card()).toHaveTextContent('more than the $24,500 the IRS allows for 2026');
    expect(card()).toHaveTextContent('above the 2026 compensation limit');
  });
});

describe('Match401kCard calculating', () => {
  it('calculates from 0% with the age the birth year gives for the tax year', async () => {
    decisionsReady();
    const seen = requests();
    renderCard();
    await within(await screen.findByRole('region', { name: '401(k) match' })).findByRole('slider');
    expect(within(card()).getByText('Not saved')).toBeInTheDocument();

    await settle();
    await waitFor(() =>
      expect(result()).toHaveTextContent('You leave the whole $2,600 match behind'),
    );
    // Born in 1996, so 30 by the end of 2026.
    expect(seen.calc.map((body) => body.contribution_pct)).toEqual(['0.00']);
    expect(seen.calc[0]).toEqual(sampleK401(0).inputs);
    expect(saveButton()).toHaveTextContent('Save this decision');
    expect(saveButton()).toBeEnabled();
  });

  it('sends one request after a drag settles, and marks the result busy until it lands', async () => {
    savedDecision();
    const seen = requests();
    await renderReady();
    expect(seen.calc).toHaveLength(1);

    // One drag across three stops: no time passes between them.
    drag(1);
    drag(2);
    drag(3);
    const stoppedAt = Date.now();
    expect(result()).toHaveAttribute('aria-busy', 'true');
    // The previous numbers stay while the next ones load.
    expect(result()).toHaveTextContent('At 4% you would capture the full $2,600 match');
    expect(saveButton()).toBeDisabled();
    expect(seen.calc).toHaveLength(1);

    await settle();
    await waitFor(() => expect(result()).not.toHaveAttribute('aria-busy', 'true'));
    expect(seen.calc.map((body) => body.contribution_pct)).toEqual(['4.00', '3.00']);
    // Measured on the test clock, so a slow machine cannot make it pass or fail.
    expect(seen.calcAt[1]! - stoppedAt).toBeGreaterThanOrEqual(CALC_DEBOUNCE_MS);
    expect(result()).toHaveTextContent('At 3% you would leave $650 of match behind');
    expect(within(result()).getByText('$27.08')).toBeInTheDocument();
    expect(within(card()).getByText('Changed since v1')).toBeInTheDocument();
    expect(saveButton()).toHaveTextContent('Save as v2');
  });
});

describe('Match401kCard and the rate the pay stub shows (spec 006 rule 14, issue 132)', () => {
  it('starts from the newest stub rate when nothing is saved, and says what it leaves', async () => {
    // stub-01: $109.62 of $3,653.85 goes to the 401(k), which the API reports as 3.00.
    stub01Ready();
    const seen = requests();
    await renderReady();
    expect(card()).toHaveTextContent(
      'Your Apr 10 pay stub shows $109.62 a paycheck, 3% of your gross pay, going to your 401(k).',
    );
    expect(slider()).toHaveValue('3');
    expect(slider()).toHaveAttribute('aria-valuetext', '3% of salary');
    expect(seen.calc).toEqual([stub01K401(3).inputs]);
    expect(result()).toHaveTextContent('You leave $950 of match behind');
    expect(card()).not.toHaveTextContent(/leave the whole/);
    expect(within(card()).getByText('Not saved')).toBeInTheDocument();
  });

  it('speaks of 0% as a choice while the stub shows a contribution', async () => {
    stub01Ready();
    await renderReady();
    drag(0);
    await settle();
    await waitFor(() =>
      expect(result()).toHaveTextContent('At 0% you would leave the whole $3,800 match behind'),
    );
    expect(result()).not.toHaveTextContent(/^You leave the whole/);
  });

  it('opens a saved rate over the stub, as a choice until the stub shows it', async () => {
    stub01Ready();
    db.decisions = [
      sampleDecision({ inputs: { ...stub01K401(5).inputs }, result: { ...stub01K401(5).result } }),
    ];
    await renderReady();
    expect(slider()).toHaveValue('5');
    expect(result()).toHaveTextContent('At 5% you would capture the full $3,800 match');
    expect(saveButton()).toHaveTextContent('Saved as v1');
  });

  it('says the whole match is left behind only at the rate the stub shows', async () => {
    stub01Ready();
    db.payStubs = [
      stub01PayStub({ retirement_contribution_cents: 0, retirement_contribution_pct: '0.00' }),
    ];
    await renderReady();
    expect(slider()).toHaveValue('0');
    expect(result()).toHaveTextContent('You leave the whole $3,800 match behind');
  });

  it('starts at 0% and speaks conditionally when the stub has no rate', async () => {
    decisionsReady();
    db.payStubs = [samplePayStub({ retirement_contribution_pct: null })];
    await renderReady();
    expect(card()).toHaveTextContent(
      'Your Oct 15 pay stub shows $0.00 a paycheck going to your 401(k).',
    );
    expect(slider()).toHaveValue('0');
    expect(result()).toHaveTextContent('At 0% you would leave the whole $2,600 match behind');
  });
});

describe('Match401kCard saving', () => {
  it('saves v1, then v2 over it, with the result the calculator returned', async () => {
    decisionsReady();
    const seen = requests();
    const { user } = renderCard();
    await within(await screen.findByRole('region', { name: '401(k) match' })).findByRole('slider');
    drag(4);
    await settle();
    await waitFor(() => expect(saveButton()).toBeEnabled());

    await user.click(saveButton());
    await waitFor(() => expect(saveButton()).toHaveTextContent('Saved as v1'));
    expect(seen.save).toEqual([
      {
        calculator: 'k401_match',
        inputs: sampleK401(4).inputs,
        result: sampleK401(4).result,
        supersedes_id: null,
      },
    ]);
    expect(within(card()).getByText('Saved v1 · Oct 17')).toBeInTheDocument();
    const v1 = db.decisions[0]!.id;
    expect(within(card()).getByRole('link', { name: 'Why this decision' })).toHaveAttribute(
      'href',
      `/why/${v1}`,
    );

    drag(6);
    await settle();
    await waitFor(() => expect(saveButton()).toHaveTextContent('Save as v2'));
    await user.click(saveButton());
    await waitFor(() => expect(saveButton()).toHaveTextContent('Saved as v2'));
    expect(seen.save[1]).toMatchObject({ supersedes_id: v1, inputs: sampleK401(6).inputs });
    expect(within(card()).getByText('Saved v2 · Oct 17')).toBeInTheDocument();
  });

  it('recalculates and asks to save again when the server finds the result out of date', async () => {
    savedDecision();
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
                details: { fields: ['missed_cents'] },
              },
            },
            { status: 422 },
          ),
        { once: true },
      ),
    );
    const { user } = await renderReady();
    drag(6);
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
    expect(
      within(card()).queryByText(/The calculator's numbers had changed/),
    ).not.toBeInTheDocument();
  });

  it('reloads the decisions and offers the next version when another save got there first', async () => {
    savedDecision();
    const { user } = await renderReady();
    db.decisions.push(
      sampleDecision({
        id: 'dec00000-0000-4000-8000-0000000000b2',
        version: 2,
        supersedes_id: DECISION_V1_ID,
        inputs: { ...sampleK401(5).inputs },
        result: { ...sampleK401(5).result },
      }),
    );
    drag(6);
    await settle();
    await waitFor(() => expect(saveButton()).toHaveTextContent('Save as v2'));

    await user.click(saveButton());
    expect(await within(card()).findByText(/saved somewhere else/)).toBeInTheDocument();
    await waitFor(() => expect(saveButton()).toHaveTextContent('Save as v3'));
    expect(within(card()).getByText('Changed since v2')).toBeInTheDocument();
  });
});

describe('Match401kCard plan details', () => {
  it('asks for the match formula when the profile has none, and saves it to the profile', async () => {
    decisionsReady();
    db.profile = { ...emptyProfile };
    const puts: unknown[] = [];
    server.events.on('request:start', async ({ request }) => {
      if (request.method === 'PUT') puts.push(await request.clone().json());
    });
    const { user } = renderCard();
    const form = await within(
      await screen.findByRole('region', { name: '401(k) match' }),
    ).findByRole('form', { name: 'Your plan details' });
    expect(within(card()).queryByRole('slider')).not.toBeInTheDocument();

    // The stub's figure starts the field; this person types their offer letter's.
    await user.clear(within(form).getByLabelText('Yearly salary'));
    await user.type(within(form).getByLabelText('Yearly salary'), '65,000');
    await user.click(within(form).getByRole('button', { name: 'Single' }));
    await user.type(within(form).getByLabelText('Employer adds, % of what you put in'), '100');
    await user.type(within(form).getByLabelText('Up to, % of your pay'), '4');
    await user.type(within(form).getByLabelText('Year you were born'), '1996');
    await user.click(within(form).getByRole('button', { name: 'Save plan details' }));

    await within(card()).findByRole('slider');
    expect(puts).toEqual([
      {
        birth_year: 1996,
        dependents: 0,
        expected_healthcare_usage: null,
        filing_status: 'single',
        match_tiers: [{ employer_pct: '100', employee_pct_upto: '4' }],
        other_jobs: [],
        pay_frequency: 'semimonthly',
        salary_cents: 6_500_000,
        start_date: null,
        vesting_years: null,
      },
    ]);
    expect(card()).toHaveTextContent(
      'Acme Corp matches 100% of the first 4% of your $65,000 salary.',
    );
  });

  it('asks once for the birth year a profile saved before it existed, keeping the rest', async () => {
    decisionsReady();
    db.profile = { ...db.profile, birth_year: null };
    const { user } = renderCard();
    const form = await within(
      await screen.findByRole('region', { name: '401(k) match' }),
    ).findByRole('form', { name: 'Your plan details' });
    expect(within(form).getByLabelText('Yearly salary')).toHaveValue('65,000.00');
    await user.type(within(form).getByLabelText('Year you were born'), '1996');
    await user.click(within(form).getByRole('button', { name: 'Save plan details' }));

    await within(card()).findByRole('slider');
    expect(db.profile).toMatchObject({ birth_year: 1996, salary_cents: 6_500_000 });
    await settle();
    await waitFor(() => expect(result()).toHaveTextContent('You leave the whole $2,600 match'));
  });

  it("starts a new user's salary from the confirmed stub, so plan details save without retyping it", async () => {
    // Spec 005 rule 24a: the API reports the yearly salary the stub implies
    // (2,708.33 twice a month is 64,999.92), a real value in the field.
    decisionsReady();
    db.profile = { ...emptyProfile };
    const puts: { salary_cents?: number }[] = [];
    server.events.on('request:start', async ({ request }) => {
      if (request.method === 'PUT') puts.push(await request.clone().json());
    });
    const { user } = renderCard();
    const form = await within(
      await screen.findByRole('region', { name: '401(k) match' }),
    ).findByRole('form', { name: 'Your plan details' });
    const salary = within(form).getByLabelText('Yearly salary');
    expect(salary).toHaveValue('64,999.92');
    expect(salary).toHaveAccessibleDescription(
      'From your pay stub of Oct 15, 2026, as a year of paychecks like it. Change it if that paycheck had overtime or a bonus.',
    );
    const birthYear = within(form).getByLabelText('Year you were born');
    expect(birthYear).toHaveValue('');
    expect(birthYear).toHaveAttribute('placeholder', 'for example 1996');

    await user.click(within(form).getByRole('button', { name: 'Single' }));
    await user.type(within(form).getByLabelText('Employer adds, % of what you put in'), '100');
    await user.type(within(form).getByLabelText('Up to, % of your pay'), '4');
    await user.type(birthYear, '1996');
    await user.click(within(form).getByRole('button', { name: 'Save plan details' }));

    await within(card()).findByRole('slider');
    expect(puts).toHaveLength(1);
    expect(puts[0]?.salary_cents).toBe(SAMPLE_ANNUAL_SALARY_CENTS);
    await settle();
    await waitFor(() => expect(result()).toHaveTextContent('You leave the whole $2,600 match'));
  });

  it('says what to fix before sending anything, with examples that read as examples', async () => {
    // A stub with no pay schedule: the API reports no yearly salary for it,
    // so the field starts empty, and its placeholder must not look like a value.
    decisionsReady();
    db.profile = { ...emptyProfile };
    db.payStubs = [samplePayStub({ pay_frequency: null, annual_salary_cents: null })];
    const { user } = renderCard();
    const form = await within(
      await screen.findByRole('region', { name: '401(k) match' }),
    ).findByRole('form', { name: 'Your plan details' });
    const salary = within(form).getByLabelText('Yearly salary');
    expect(salary).toHaveValue('');
    expect(salary).toHaveAttribute('placeholder', 'for example 65,000.00');
    expect(parseMoney(salary.getAttribute('placeholder') ?? '')).toBeNull();
    expect(within(form).getByLabelText('Year you were born')).toHaveAttribute(
      'placeholder',
      'for example 1996',
    );

    await user.click(within(form).getByRole('button', { name: 'Save plan details' }));
    expect(salary).toHaveAccessibleDescription('Enter your yearly salary, like 65,000.00.');
    expect(within(form).getByLabelText('Year you were born')).toHaveAccessibleDescription(
      'Enter the year you were born, like 1996.',
    );
    expect(within(form).getByText('Choose your filing status.')).toBeInTheDocument();
    expect(within(form).getByText('Choose how often you are paid.')).toBeInTheDocument();
    expect(db.profile.salary_cents).toBeNull();
  });

  it('lets a saved formula be changed', async () => {
    savedDecision();
    const { user } = await renderReady();
    await user.click(within(card()).getByRole('button', { name: 'Change plan details' }));
    const form = within(card()).getByRole('form', { name: 'Your plan details' });
    expect(within(form).getByLabelText('Yearly salary')).toHaveValue('65,000.00');
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(within(card()).getByRole('slider')).toBeInTheDocument();
  });
});

describe('Match401kCard focus (issue 167)', () => {
  const changePlan = () => within(card()).getByRole('button', { name: 'Change plan details' });
  const form = () => within(card()).getByRole('form', { name: 'Your plan details' });

  it('opens the plan details on their first field and returns to Change plan details', async () => {
    savedDecision();
    const { user } = await renderReady();
    await user.click(changePlan());
    expect(within(form()).getByLabelText('Yearly salary')).toHaveFocus();

    await user.click(within(form()).getByRole('button', { name: 'Cancel' }));
    expect(changePlan()).toHaveFocus();

    await user.click(changePlan());
    await user.click(within(form()).getByRole('button', { name: 'Save plan details' }));
    await waitFor(() => expect(changePlan()).toHaveFocus());
  });

  it('hands focus to the contribution once the first plan details are saved', async () => {
    decisionsReady();
    db.profile = { ...db.profile, birth_year: null };
    const { user } = renderCard();
    const details = await within(
      await screen.findByRole('region', { name: '401(k) match' }),
    ).findByRole('form', { name: 'Your plan details' });
    await user.type(within(details).getByLabelText('Year you were born'), '1996');
    await user.click(within(details).getByRole('button', { name: 'Save plan details' }));
    await waitFor(() => expect(slider()).toHaveFocus());
  });

  it('focuses the tier that a tier added or removed leaves in its place', async () => {
    savedDecision();
    const { user } = await renderReady();
    await user.click(changePlan());
    await user.click(within(form()).getByRole('button', { name: 'Add a tier' }));
    expect(
      within(form()).getByLabelText('Tier 2: Employer adds, % of what you put in'),
    ).toHaveFocus();

    await user.click(within(form()).getByRole('button', { name: 'Remove tier 2' }));
    expect(within(form()).getByLabelText('Employer adds, % of what you put in')).toHaveFocus();
  });
});

describe('Match401kCard before it can calculate', () => {
  it('sends a person without a confirmed pay stub to confirm one', async () => {
    renderCard();
    const region = await screen.findByRole('region', { name: '401(k) match' });
    expect(
      await within(region).findByRole('link', { name: 'Confirm your pay stub' }),
    ).toHaveAttribute('href', '/setup/confirm');
    expect(within(region).queryByRole('slider')).not.toBeInTheDocument();
  });

  it("shows the calculator's refusal as a sentence", async () => {
    savedDecision();
    server.use(
      http.post(apiUrl('/calc/401k-match'), () =>
        HttpResponse.json(
          {
            error: { code: 'validation_error', message: 'no federal constants for tax year 2026' },
          },
          { status: 422 },
        ),
      ),
    );
    renderCard();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'no federal constants for tax year 2026',
    );
    expect(result()).not.toHaveTextContent('You capture');
    drag(6);
    await settle();
    await waitFor(() => expect(saveButton()).toHaveTextContent('Save as v2'));
    expect(saveButton()).toBeDisabled();
  });
});
