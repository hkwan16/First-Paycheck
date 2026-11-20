import { readFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { e2eApiUrl, NO_E2E_API } from './support/api';
import { dayUser, NO_DAY_USER, submitSignIn, waitForHydration } from './support/auth';
import {
  addDays,
  dateIn,
  mediumDate,
  monthStart,
  monthYear,
  periodWithinMonth,
  zoneOffTheUtcDate,
} from './support/days';

/*
 * Issue 232, end to end, as the production pass met it: at 22:27 Pacific on
 * November 9 the app already counted November 10. Spending said "November 1
 * to 10", the plan "As of Nov 10, 2026" and "Through Feb 8, 2027", the PDF was
 * named for November 10, and a check-in run that evening counted one day
 * fewer to its dates.
 *
 * The person's browser runs in a zone whose date is not UTC's while the test
 * runs (support/days.ts; spec 019, "The e2e test's zone"): every screen and
 * the PDF must show the browser's date. The first page they open saves the
 * browser's zone on their profile (spec 019 rule 5); the API then answers
 * every date in it. The account is new on each run of scripts/e2e_stack.py
 * (E2E_DAY_USER_*).
 */

const ZONE = zoneOffTheUtcDate(new Date());

test.use({ timezoneId: ZONE });
test.describe.configure({ mode: 'serial' });
test.skip(!dayUser(), NO_DAY_USER);
test.skip(!e2eApiUrl(), NO_E2E_API);

// The worker renders the PDF; the first one on a fresh stack loads fonts.
const EXPORT_BUDGET_MS = 120_000;
const RUN_BUDGET_MS = 90_000;

/** The API, as the signed-in person: every call carries the token the app sends. */
class Api {
  constructor(
    private readonly request: APIRequestContext,
    private readonly authorization: string,
  ) {}

  async call<T>(method: 'GET' | 'POST', route: string, data?: unknown): Promise<T> {
    const response = await this.request.fetch(`${e2eApiUrl()}${route}`, {
      method,
      headers: { authorization: this.authorization },
      ...(data === undefined ? {} : { data }),
    });
    expect(response.ok(), `${method} ${route}: ${await response.text()}`).toBe(true);
    return (await response.json()) as T;
  }

  /** One synthetic checking row dated `date`, imported as a new CSV account. */
  async importRowOn(date: string) {
    const response = await this.request.post(`${e2eApiUrl()}/accounts/import`, {
      headers: { authorization: this.authorization },
      multipart: {
        kind: 'checking',
        name: 'E2E Day Checking',
        institution_name: 'E2E Day Credit Union',
        file: {
          name: 'day.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from(`Date,Description,Amount\n${date},BLUE BOTTLE COFFEE,-6.25\n`),
        },
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }

  /** Calculate and save a health plan choice with `deadline`, as the step's save does. */
  async saveHealthPlan(deadline: string) {
    const inputs = {
      salary_cents: 6_500_000,
      pay_periods_per_year: 24,
      tax_year: Number(deadline.slice(0, 4)),
      filing_status: 'single',
      plans: [
        {
          name: 'Value HMO',
          kind: 'hmo',
          premium_per_period_cents: 400,
          deductible_cents: 150_000,
          coinsurance_pct: '20',
          oop_max_cents: 400_000,
          employer_hsa_cents: 0,
        },
      ],
      employee_hsa_cents: 0,
      expected_usage: 'medium',
      usage_low_cents: 50_000,
      usage_medium_cents: 300_000,
      usage_high_cents: 1_000_000,
      selected_plan_index: 0,
      enrollment_deadline: deadline,
    };
    const result = await this.call<Record<string, unknown>>('POST', '/calc/health-plans', inputs);
    await this.call('POST', '/decisions', {
      calculator: 'health_plans',
      inputs,
      result,
      supersedes_id: null,
    });
  }
}

/** Sign in through the form, and the token the app then sends to the API. */
async function signInAndAuthorize(page: Page) {
  const user = dayUser()!;
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

test('every screen and the PDF count the browser’s day, not UTC’s (issue 232)', async ({
  page,
}) => {
  test.setTimeout(EXPORT_BUDGET_MS + 4 * RUN_BUDGET_MS);
  const today = dateIn(ZONE);
  expect(today, `${ZONE} should be on another date than UTC now`).not.toBe(dateIn('UTC'));

  const api = await signInAndAuthorize(page);
  // The first page the person opened saved the browser's zone (spec 019 rule 5).
  await expect
    .poll(async () => api.call<{ time_zone: string | null; today: string }>('GET', '/profile'), {
      timeout: 30_000,
    })
    .toMatchObject({ time_zone: ZONE, today });

  // Spending: this month so far ends today (the issue's "November 1 to 10").
  await api.importRowOn(today);
  await page.goto('/setup/spending');
  await waitForHydration(page);
  const picker = page.getByRole('combobox', { name: 'Period' });
  await expect(picker).toBeEnabled({ timeout: 30_000 });
  await picker.selectOption({ label: `${monthYear(today)} so far` });
  await expect(
    page.getByRole('region', {
      name: new RegExp(`^${periodWithinMonth(monthStart(today), today)} · no pay stub$`),
    }),
  ).toBeVisible({ timeout: 30_000 });

  // A deadline on the person's today is due today: the save makes its date,
  // and the plan lists it without calling it overdue.
  await api.saveHealthPlan(today);
  await page.goto('/plan');
  await waitForHydration(page);
  await expect(page.getByText(`As of ${mediumDate(today)}.`)).toBeVisible({ timeout: 30_000 });
  const calendar = page.getByRole('region', { name: 'Next 90 days' });
  await expect(calendar.getByText(`Through ${mediumDate(addDays(today, 90))}`)).toBeVisible();
  const deadline = calendar
    .getByRole('listitem')
    .filter({ hasText: 'Health plan enrollment deadline' });
  await expect(deadline).toContainText(`Due ${mediumDate(today)}`);
  await expect(deadline.getByText('Overdue')).toHaveCount(0);

  // The PDF is prepared on, and named for, the person's today.
  const exportCard = page.getByRole('region', { name: 'Export' });
  const downloaded = page.waitForEvent('download', { timeout: EXPORT_BUDGET_MS });
  await exportCard.getByRole('button', { name: 'Download PDF' }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe(`first-paycheck-plan-${today}.pdf`);
  const bytes = await readFile((await download.path())!);
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');

  // Check in now checks in the person's month, and its dates count from today.
  await page.goto('/check-in');
  await waitForHydration(page);
  await page.getByRole('button', { name: 'Check in now' }).click();
  // The stack's first scheduler tick may already have made this month's check-in.
  await expect(
    page.getByText(/^(This month’s check-in is ready|Checked this month again)/),
  ).toBeVisible({ timeout: RUN_BUDGET_MS });
  const list = page.getByRole('list', { name: 'Check-ins' });
  await list
    .getByRole('listitem')
    .first()
    .getByRole('link', { name: monthYear(today) })
    .click();
  await waitForHydration(page);
  const findings = page.getByRole('region', { name: 'What changed' });
  await expect(findings).toBeVisible({ timeout: 30_000 });
  const finding = findings
    .getByRole('listitem')
    .filter({ hasText: 'Health plan enrollment deadline' });
  await expect(finding).toBeVisible();
  await expect(finding).not.toContainText('It was due');
  const comingUp = page.getByRole('region', { name: 'Coming up' });
  const date = comingUp
    .getByRole('listitem')
    .filter({ hasText: 'Health plan enrollment deadline' });
  await expect(date).toContainText(`Due ${mediumDate(today)}`);
  await expect(date.getByText('Overdue')).toHaveCount(0);
});
