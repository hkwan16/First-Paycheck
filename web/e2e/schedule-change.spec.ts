import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { e2eApiUrl, NO_E2E_API, openLink } from './support/api';
import { NO_SCHEDULE_USER, scheduleUser, submitSignIn, waitForHydration } from './support/auth';

/*
 * Issues 221 and 222, end to end, as the production e2e account met them: a
 * person confirmed an older stub paid every two weeks (stub-01: $3,653.85,
 * 26 paychecks, so plan details saved $95,000.10), saved the 401(k), health
 * plan and W-4 on it, and then confirmed the Acme stub, paid twice a month
 * ($2,708.33, 24 paychecks, $64,999.92 a year).
 *
 * The history before the new stub is made through the API with the user's own
 * token, with the calls and bodies the screens send (upload, read, confirm
 * with the values typed, plan details, calculate, save); the new stub is
 * uploaded and confirmed through the screens. Then:
 *
 * - issue 221: the 401(k) and W-4 steps say the newest stub's yearly pay
 *   differs from the saved salary and ask which to use, and show no numbers
 *   mixing the old salary with the new schedule until the person answers;
 * - issue 222: the saved decisions need review: each step says what changed,
 *   the side nav does not tick them, and the plan marks them and does not
 *   show their old per-paycheck figures;
 * - answering and saving again settles every step and the plan.
 *
 * The account is new on each run of scripts/e2e_stack.py (E2E_SCHEDULE_USER_*).
 */

const FIXTURE = path.join(__dirname, 'fixtures', 'acme-paystub.pdf');

test.describe.configure({ mode: 'serial' });
test.skip(!scheduleUser(), NO_SCHEDULE_USER);
test.skip(!e2eApiUrl(), NO_E2E_API);

/** stub-01 as the person confirmed it (api/tests/support/factories.py:STUB_01). */
const STUB_01 = {
  employer_name: 'Acme Corp',
  pay_frequency: 'biweekly',
  pay_date: '2026-04-10',
  period_start: '2026-03-23',
  period_end: '2026-04-05',
  gross_cents: 365_385,
  federal_withholding_cents: 27_244,
  social_security_cents: 22_654,
  medicare_cents: 5_298,
  state_tax_cents: 16_442,
  retirement_contribution_cents: 10_962,
  medical_premium_cents: 2_500,
  other_deductions_cents: 5_199,
  net_cents: 275_086,
};
// stub-01's gross times 26 (spec 005 rule 24a), what plan details offered.
const OLD_SALARY = 9_500_010;
const TIERS = [
  { employee_pct_upto: '3', employer_pct: '100' },
  { employee_pct_upto: '5', employer_pct: '50' },
];
const PLANS = [
  {
    name: 'Value HMO',
    kind: 'hmo',
    premium_per_period_cents: 400,
    deductible_cents: 150_000,
    coinsurance_pct: '20',
    oop_max_cents: 400_000,
    employer_hsa_cents: 0,
  },
  {
    name: 'Saver HDHP',
    kind: 'hdhp',
    premium_per_period_cents: 0,
    deductible_cents: 170_000,
    coinsurance_pct: '20',
    oop_max_cents: 500_000,
    employer_hsa_cents: 50_000,
  },
];

/** The API, as the signed-in person: every call carries the token the app sends. */
class Api {
  constructor(
    private readonly request: APIRequestContext,
    private readonly authorization: string,
  ) {}

  async call<T>(method: 'GET' | 'POST' | 'PUT', route: string, data?: unknown): Promise<T> {
    const response = await this.request.fetch(`${e2eApiUrl()}${route}`, {
      method,
      headers: { authorization: this.authorization },
      ...(data === undefined ? {} : { data }),
    });
    expect(response.ok(), `${method} ${route}: ${await response.text()}`).toBe(true);
    return (await response.json()) as T;
  }

  /** Upload a pay stub, have the worker read it, and confirm it with `values`. */
  async confirmStub(values: Record<string, unknown>) {
    const upload = await this.request.post(`${e2eApiUrl()}/docs`, {
      headers: { authorization: this.authorization },
      multipart: {
        type: 'pay_stub',
        file: { name: 'stub.pdf', mimeType: 'application/pdf', buffer: await readFile(FIXTURE) },
      },
    });
    expect(upload.ok(), await upload.text()).toBe(true);
    const { document_id: id } = (await upload.json()) as { document_id: string };
    const { job_id } = await this.call<{ job_id: string }>('POST', `/docs/${id}/extract`);
    await expect
      .poll(async () => (await this.call<{ status: string }>('GET', `/jobs/${job_id}`)).status, {
        timeout: 120_000,
      })
      .toBe('succeeded');
    await this.call('POST', `/docs/${id}/confirm`, { pay_stub: values });
  }

  /** Calculate and save, as a step's save button does. */
  async save(calculator: string, route: string, inputs: Record<string, unknown>) {
    const result = await this.call<Record<string, unknown>>('POST', route, inputs);
    await this.call('POST', '/decisions', { calculator, inputs, result, supersedes_id: null });
  }
}

/** Sign in through the form, and the token the app then sends to the API. */
async function signInAndAuthorize(page: Page) {
  const user = scheduleUser()!;
  await page.goto('/sign-in');
  const first = page.waitForResponse(
    (response) => response.url().startsWith(e2eApiUrl()!) && response.request().method() === 'GET',
    { timeout: 30_000 },
  );
  await submitSignIn(page, user.email, user.password);
  await expect(page).toHaveURL('/setup/link', { timeout: 30_000 });
  const { authorization } = await (await first).request().allHeaders();
  return new Api(page.request, authorization!);
}

/** Before the new stub: stub-01 confirmed, plan details from it, three decisions on it. */
async function savedOnTheOldSchedule(api: Api) {
  await api.confirmStub(STUB_01);
  const profile = await api.call<{ match_tiers: unknown[] }>('PUT', '/profile', {
    salary_cents: OLD_SALARY,
    filing_status: 'single',
    match_tiers: TIERS,
    birth_year: 2002,
  });
  const common = { salary_cents: OLD_SALARY, pay_periods_per_year: 26, tax_year: 2026 };
  await api.save('k401_match', '/calc/401k-match', {
    ...common,
    match_tiers: profile.match_tiers,
    contribution_pct: '5.00',
    filing_status: 'single',
    age: 24,
  });
  await api.save('health_plans', '/calc/health-plans', {
    ...common,
    plans: PLANS,
    filing_status: 'single',
    employee_hsa_cents: 0,
    expected_usage: 'medium',
    usage_low_cents: 50_000,
    usage_medium_cents: 300_000,
    usage_high_cents: 1_000_000,
    selected_plan_index: 0,
    enrollment_deadline: null,
  });
  // Spec 014 example 11: the e2e account's W-4, $423.16 a paycheck on 26.
  await api.save('w4', '/calc/w4', {
    ...common,
    filing_status: 'single',
    k401_contribution_pct: '5.00',
    age: 24,
    health_premium_per_paycheck_cents: 400,
    multiple_jobs: false,
    dependents_credit_cents: 0,
    other_income_cents: 0,
    deductions_cents: 0,
    extra_withholding_cents: 0,
    expected_deductions_cents: null,
    other_jobs_wages_cents: 0,
    other_jobs_withholding_cents: 0,
    current_withholding_per_paycheck_cents: STUB_01.federal_withholding_cents,
  });
}

/** Upload the Acme stub (paid twice a month) on Link and confirm it on Confirm. */
async function confirmTheNewStub(page: Page) {
  await openLink(page);
  const docs = page.getByRole('region', { name: 'Documents' });
  await docs.getByLabel('Document type').selectOption('pay_stub');
  await docs.getByLabel(/Add (another|a) document/).setInputFiles(FIXTURE);
  const row = docs.getByRole('group', { name: /^Pay stub/ }).first();
  await expect(row.getByText('Review needed')).toBeVisible({ timeout: 180_000 });
  await row.getByRole('link', { name: 'Review pay stub' }).click();
  await waitForHydration(page);
  const fields = page.getByRole('region', { name: 'What we read' });
  await page.getByRole('button', { name: 'Confirm all remaining' }).click();
  await expect(fields.getByText('The math checks out.')).toBeVisible();
  await page.getByRole('button', { name: /Confirm and continue/ }).click();
  await expect(page).toHaveURL('/setup/spending', { timeout: 30_000 });
}

/** The side nav's link to a step, done or not ("Health plan, done"). */
const navStep = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Setup steps' })
    .getByRole('link', { name: new RegExp(`^${name.replace(/[()]/g, '\\$&')}(\\s*, done)?$`) });

async function openStep(page: Page, slug: string, card: string) {
  await page.goto(`/setup/decisions/${slug}`);
  await waitForHydration(page);
  const region = page.getByRole('region', { name: card });
  await expect(region).not.toHaveAttribute('aria-busy', 'true', { timeout: 30_000 });
  return region;
}

const SCHEDULE_CHANGED = 'Your pay schedule changed from 26 to 24 paychecks a year.';

test('saved decisions on the old pay schedule need review (issue 222)', async ({ page }) => {
  test.setTimeout(420_000);
  const api = await signInAndAuthorize(page);
  await savedOnTheOldSchedule(api);
  await confirmTheNewStub(page);

  // The health plan step opens saying what changed, not "Changes not saved".
  const health = await openStep(page, 'health-plan', 'Health plan');
  await expect(health.getByText('Needs review', { exact: true })).toBeVisible();
  await expect(health.getByText('Changes not saved')).toHaveCount(0);
  await expect(health).toContainText(SCHEDULE_CHANGED);

  // None of the three is ticked off while it needs review.
  for (const name of ['401(k) match', 'Health plan', 'W-4']) {
    await expect(navStep(page, name)).toHaveAccessibleName(
      new RegExp(`^${name.replace(/[()]/g, '\\$&')}$`),
    );
  }

  // The plan marks them and shows none of their old per-paycheck figures.
  await page.goto('/plan');
  await waitForHydration(page);
  await expect(page.getByText(/^3 of 4 decisions saved, 3 need review$/)).toBeVisible({
    timeout: 30_000,
  });
  const planHealth = page.getByRole('region', { name: 'Health plan' });
  await expect(planHealth.getByText('Needs review', { exact: true })).toBeVisible();
  await expect(planHealth).toContainText(SCHEDULE_CHANGED);
  await expect(planHealth.getByText('Premiums a year')).toHaveCount(0);
  const planW4 = page.getByRole('region', { name: 'W-4, federal only' });
  await expect(planW4.getByText('Needs review', { exact: true })).toBeVisible();
  await expect(planW4.getByText(/Federal tax withheld per paycheck/)).toHaveCount(0);
});

test('the 401(k) and W-4 steps ask which salary to use (issue 221)', async ({ page }) => {
  test.setTimeout(120_000);
  await signInAndAuthorize(page);
  for (const [slug, name] of [
    ['401k', '401(k) match'],
    ['w4', 'W-4, federal only'],
  ] as const) {
    const card = await openStep(page, slug, name);
    const question = card.getByRole('group', { name: 'Which yearly salary should we use?' });
    await expect(question).toContainText(
      'Your Oct 15, 2026 pay stub pays $2,708.33 twice a month, which comes to $64,999.92 a year.',
    );
    await expect(question).toContainText('The salary in your plan details is $95,000.10.');
    await expect(question.getByRole('button', { name: 'Use $64,999.92' })).toBeVisible();
    await expect(question.getByRole('button', { name: 'Keep $95,000.10' })).toBeVisible();
    // Nothing is worked out from the old salary on the new schedule meanwhile.
    await expect(card.getByRole('group', { name: 'Your numbers' })).toHaveCount(0);
  }
});

test("using the stub's salary and saving again settles every step and the plan", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInAndAuthorize(page);

  const k401 = await openStep(page, '401k', '401(k) match');
  await k401.getByRole('button', { name: 'Use $64,999.92' }).click();
  await expect(k401.getByRole('group', { name: 'Your numbers' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(k401).toContainText('of your $65,000 salary');

  for (const [slug, name] of [
    ['401k', '401(k) match'],
    ['health-plan', 'Health plan'],
    ['w4', 'W-4, federal only'],
  ] as const) {
    const card = await openStep(page, slug, name);
    await expect(card.getByText('Needs review', { exact: true })).toBeVisible();
    await expect(card).toContainText(SCHEDULE_CHANGED);
    await expect(card).toContainText('Your yearly salary changed from $95,000.10 to $64,999.92.');
    const result = card.getByRole('group', { name: 'Your numbers' });
    await expect(result).not.toHaveAttribute('aria-busy', 'true', { timeout: 15_000 });
    const save = card.getByRole('button', { name: 'Save again' });
    await expect(save).toBeEnabled({ timeout: 15_000 });
    await save.click();
    await expect(card.getByRole('button', { name: 'Saved' })).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText('Needs review', { exact: true })).toHaveCount(0);
    await expect(navStep(page, name === 'W-4, federal only' ? 'W-4' : name)).toHaveAccessibleName(
      /, done$/,
      { timeout: 15_000 },
    );
  }

  await page.goto('/plan');
  await waitForHydration(page);
  await expect(page.getByText(/^3 of 4 decisions saved$/)).toBeVisible({ timeout: 30_000 });
  const planHealth = page.getByRole('region', { name: 'Health plan' });
  // $4.00 a paycheck, 24 paychecks a year.
  await expect(planHealth).toContainText(/Premiums a year\s*\$96\.00/);
  await expect(page.getByText('Needs review', { exact: true })).toHaveCount(0);
});
