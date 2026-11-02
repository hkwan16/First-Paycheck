import { expect, test, type Locator, type Page } from '@playwright/test';
import { formatMoney } from '../src/lib/money';
import { e2eApiUrl, NO_E2E_API } from './support/api';
import { e2eUser, NO_E2E_USER, waitForHydration } from './support/auth';

/*
 * The decisions against the real API with the saved e2e session, after
 * confirm.spec.ts has confirmed a pay stub. The 401(k): fill in the plan
 * details if the profile lacks any (the birth year included), calculate, save
 * a version, change it and save the next one over it, then open its
 * explanation. The emergency fund: save a version and pause and resume its
 * goal. The health plan: type two synthetic plans when no benefits summary is
 * confirmed, choose one and save it with an enrollment deadline. The W-4:
 * read the saved 401(k) rate and health premium, change Step 4(c), check the
 * card states what the stub's withholding leaves at tax time in the
 * calculator's figure (issue 153), and save a version with its reminder to
 * hand the form in. Each calculator is its own
 * step (spec 018): the old address redirects to the first, the side nav and
 * the footers move between them. The e2e user
 * keeps its decisions between runs (they cannot be deleted), so each test
 * reads the version a save made from the API's answer instead of assuming v1;
 * the step itself names no version (spec 018 rule 5a).
 */

test.describe.configure({ mode: 'serial' });
test.skip(!e2eUser(), NO_E2E_USER);
test.skip(!e2eApiUrl(), NO_E2E_API);

const card = (page: Page) => page.getByRole('region', { name: '401(k) match' });
const result = (page: Page) => card(page).getByRole('group', { name: 'Your numbers' });
const SAVE = /^(Save|Save changes|Saved)$/;
const saveButton = (page: Page) => card(page).getByRole('button', { name: SAVE });

async function settled(page: Page) {
  await expect(result(page)).not.toHaveAttribute('aria-busy', 'true', { timeout: 15_000 });
  await expect(result(page)).toContainText(/(You|you would) (capture|leave)/);
}

async function setContribution(slider: Locator, percent: number) {
  await slider.fill(String(percent));
}

/**
 * Press a card's save and wait for "Saved"; the version it made, from the
 * API's answer, since the step names none (spec 018 rule 5a).
 */
async function saveVersion(page: Page, save: Locator) {
  const answer = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/decisions' && response.request().method() === 'POST',
    { timeout: 15_000 },
  );
  await save.click();
  const { version } = (await (await answer).json()) as { version: number };
  await expect(save).toHaveText('Saved', { timeout: 15_000 });
  return version;
}

/** The side nav's link to a decision step, done or not ("401(k) match, done"). */
const navStep = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Setup steps' })
    .getByRole('link', { name: new RegExp(`^${name.replace(/[()]/g, '\\$&')}(\\s*, done)?$`) });

test('calculates, saves a version, saves the next one over it and opens why', async ({ page }) => {
  test.setTimeout(120_000);
  // The one-page address redirects to the first step; the nav opens the 401(k).
  await page.goto('/setup/decisions');
  await expect(page).toHaveURL('/setup/decisions/emergency-fund');
  await waitForHydration(page);
  await navStep(page, '401(k) match').click();
  await expect(page).toHaveURL('/setup/decisions/401k');
  await expect(navStep(page, '401(k) match')).toHaveAttribute('aria-current', 'page');
  await expect(
    page.getByRole('heading', { level: 1, name: 'How much to put in your 401(k)' }),
  ).toBeVisible();
  await expect(card(page)).not.toHaveAttribute('aria-busy', 'true', { timeout: 30_000 });

  const form = card(page).getByRole('form', { name: 'Your plan details' });
  if (await form.isVisible()) {
    await form.getByLabel('Yearly salary').fill('65,000');
    await form.getByRole('button', { name: 'Single' }).click();
    await form.getByLabel('Employer adds, as a % of what you put in').fill('100');
    await form.getByLabel('Up to this % of your pay').fill('4');
    await form.getByLabel('Year you were born').fill('1996');
    await form.getByRole('button', { name: 'Save plan details' }).click();
  }

  const slider = card(page).getByRole('slider', { name: /Your contribution/ });
  await expect(slider).toBeVisible({ timeout: 30_000 });

  // Move away from whatever is saved, so there is a version to save.
  const start = Number(await slider.inputValue());
  const first = start === 4 ? 5 : 4;
  await setContribution(slider, first);
  await settled(page);
  await expect(saveButton(page)).toBeEnabled();
  const saved = await saveVersion(page, saveButton(page));

  await setContribution(slider, first === 4 ? 6 : 3);
  await settled(page);
  await expect(saveButton(page)).toHaveText('Save changes');
  await expect(card(page).getByText('Changes not saved')).toBeVisible();
  expect(await saveVersion(page, saveButton(page))).toBe(saved + 1);

  await card(page).getByRole('link', { name: 'Why this decision' }).click();
  await expect(page).toHaveURL(/\/why\/[^/]+$/);
  await waitForHydration(page);
  const second = first === 4 ? 6 : 3;
  await expect(
    page.getByRole('heading', { level: 1, name: `Why contribute ${second}% to your 401(k)` }),
  ).toBeVisible();

  const none = page.getByRole('region', { name: 'No explanation yet' });
  const verified = page.getByText(/^We checked every number here/);
  const fallback = page.getByText(/^We could not write an explanation/);
  await expect(verified.or(fallback).or(none)).toBeVisible({ timeout: 30_000 });
  if (await none.isVisible()) {
    await none.getByRole('button', { name: 'Write the explanation' }).click();
  }
  // Verified, a fallback, or no model configured on this API: each is an answer.
  await expect(
    verified.or(fallback).or(page.getByText('Explanations are not available right now.')),
  ).toBeVisible({ timeout: 90_000 });
});

test('saves an emergency fund version and pauses and resumes its goal', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/setup/decisions/emergency-fund');
  await waitForHydration(page);
  const fund = page.getByRole('region', { name: 'Emergency fund' });
  const transfer = fund.getByLabel('Monthly transfer to savings');
  await expect(transfer).toBeVisible({ timeout: 30_000 });

  // Essentials start from the spending summary and savings from the emergency
  // fund account when the e2e user has them, which depends on the sandbox
  // bank's month (a few dollars of essentials make any savings enough). Type
  // over them, as the hint invites, so the result is the same every run.
  await fund.getByLabel('Essential spending per month').fill('1,800.00');
  await fund.getByLabel('Saved so far').fill('2,000.00');
  await fund.getByRole('slider', { name: /Months of essentials to hold/ }).fill('3');
  // Move away from whatever is saved, so there is a version to save.
  const monthly = (await transfer.inputValue()) === '300.00' ? '250.00' : '300.00';
  await transfer.fill(monthly);

  // Spec 011: the target is 3 x $1,800 = $5,400, the shortfall $3,400, and
  // the months to close it ceil(3,400 / 300) = 12 or ceil(3,400 / 250) = 14.
  const months = monthly === '300.00' ? 12 : 14;
  const result = fund.getByRole('group', { name: 'Your numbers' });
  await expect(result).not.toHaveAttribute('aria-busy', 'true', { timeout: 15_000 });
  await expect(result).toContainText(`Target $5,400, reached in ${months} months`);
  const save = fund.getByRole('button', { name: SAVE });
  await expect(save).toBeEnabled();
  await saveVersion(page, save);

  // The goal is the saved version's: its transfer toward its target.
  const goal = fund.getByRole('group', { name: 'Your emergency fund goal' });
  await expect(goal).toBeVisible({ timeout: 15_000 });
  await expect(goal).toContainText(`$${monthly} a month toward $5,400.00.`);
  // A goal marked reached earlier goes back to active first.
  const notReached = goal.getByRole('button', { name: 'Not reached yet' });
  if (await notReached.isVisible()) await notReached.click();
  const resume = goal.getByRole('button', { name: 'Resume' });
  if (await resume.isVisible()) await resume.click();
  await goal.getByRole('button', { name: 'Pause' }).click();
  await expect(goal.getByRole('button', { name: 'Resume' })).toBeVisible({ timeout: 15_000 });
  await goal.getByRole('button', { name: 'Resume' }).click();
  await expect(goal.getByRole('button', { name: 'Pause' })).toBeVisible({ timeout: 15_000 });
});

test('compares health plans, chooses one and saves it with its deadline', async ({ page }) => {
  test.setTimeout(120_000);
  // From the 401(k) step, its footer goes on to the health plan.
  await page.goto('/setup/decisions/401k');
  await waitForHydration(page);
  await page.getByRole('link', { name: 'Next: health plan' }).click();
  await expect(page).toHaveURL('/setup/decisions/health-plan');
  const health = page.getByRole('region', { name: 'Health plan' });
  const form = health.getByRole('form', { name: 'Your health plan options' });
  const usage = health.getByRole('group', { name: 'Expected healthcare use' });
  await expect(form.or(usage)).toBeVisible({ timeout: 30_000 });

  if (await form.isVisible()) {
    // Synthetic plans, typed as a person would from a benefits summary.
    const plans = [
      ['Bronze HSA', 'High deductible (HDHP)', '31.25', '1,800.00', '20', '3,500.00'],
      ['Gold PPO', 'PPO', '62.50', '250.00', '10', '3,000.00'],
    ] as const;
    for (const [index, [name, kind, premium, deductible, coinsurance, oop]] of plans.entries()) {
      if (
        index > 0 &&
        !(await form.getByRole('group', { name: `Plan ${index + 1}` }).isVisible())
      ) {
        await form.getByRole('button', { name: 'Add a plan' }).click();
      }
      const plan = form.getByRole('group', { name: `Plan ${index + 1}` });
      await plan.getByLabel('Plan name').fill(name);
      await plan.getByLabel('Plan type').selectOption({ label: kind });
      await plan.getByLabel('Premium per paycheck').fill(premium);
      await plan.getByLabel('Deductible').fill(deductible);
      await plan.getByLabel('Coinsurance, %').fill(coinsurance);
      await plan.getByLabel('Out-of-pocket maximum').fill(oop);
    }
    await form.getByRole('button', { name: 'Compare these plans' }).click();
  }

  const table = health.getByRole('table', { name: 'Expected yearly cost by plan' });
  await expect(table).toBeVisible({ timeout: 15_000 });
  // Choose the plan that is not chosen now, so there is a version to save.
  const choice = health.getByRole('group', { name: 'The plan you will enroll in' });
  const options = choice.getByRole('button');
  const firstChosen = (await options.first().getAttribute('aria-pressed')) === 'true';
  const next = firstChosen ? options.nth(1) : options.first();
  await next.click();
  await expect(next).toHaveAttribute('aria-pressed', 'true');

  const deadline = `${new Date().getFullYear() + 1}-11-14`;
  await health.getByLabel('Enrollment deadline').fill(deadline);
  const result = health.getByRole('group', { name: 'Your numbers' });
  await expect(result).not.toHaveAttribute('aria-busy', 'true', { timeout: 15_000 });
  await expect(result).toContainText('costs the least');

  const save = health.getByRole('button', { name: SAVE });
  await expect(save).toBeEnabled();
  await saveVersion(page, save);
  await expect(
    health.getByText(/^On your calendar for .+: Health plan enrollment deadline\.$/),
  ).toBeVisible({
    timeout: 15_000,
  });
});

test('reads the saved decisions into the W-4 and saves a version with its reminder', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/setup/decisions/w4');
  await waitForHydration(page);
  const w4 = page.getByRole('region', { name: 'W-4, federal only' });
  const status = w4.getByRole('group', { name: 'Filing status' });
  await expect(status).toBeVisible({ timeout: 30_000 });

  // The 401(k) and health plan tests above saved both decisions this card reads.
  const decided = w4.getByRole('group', { name: 'From your decisions' });
  await expect(decided).toContainText(/401\(k\) contribution\s*[\d.]+% of salary/);
  await expect(decided).toContainText(/Health premium per paycheck\s*\$[\d,.]+, /);

  const single = status.getByRole('button', { name: 'Single or married filing separately' });
  if ((await status.getByRole('button', { pressed: true }).count()) === 0) await single.click();
  // Move away from whatever is saved, so there is a version to save. Step 4(c)
  // waits behind "Anything else on your W-4?" (spec 014 rule 20).
  await w4
    .getByRole('group', { name: 'Anything else on your W-4?' })
    .getByRole('button', { name: 'Yes' })
    .click();
  const extra = w4.getByLabel('Step 4(c): extra withholding each paycheck');
  const entry = (await extra.inputValue()) === '25.00' ? '50.00' : '25.00';
  // The calculator's answer to the new entry. Its rule 10a figures do not
  // depend on Step 4(c), so any answer after the change states them.
  const answer = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/calc/w4' && response.request().method() === 'POST',
    { timeout: 15_000 },
  );
  await extra.fill(entry);

  const result = w4.getByRole('group', { name: 'Your numbers' });
  await expect(result).not.toHaveAttribute('aria-busy', 'true', { timeout: 15_000 });
  await expect(result).toContainText(/at tax time/);
  await expect(result).toContainText(/Taken out of each paycheck\s*\$/);

  // Beside the entries, what the confirmed stub's withholding leaves at tax time
  // (spec 014 rule 10a, issue 153), in the calculator's own figure.
  const body = (await (await answer).json()) as { current_refund_cents: number | null };
  expect(body.current_refund_cents).not.toBeNull();
  const current = body.current_refund_cents!;
  const amount = formatMoney(Math.abs(current));
  await expect(result.getByRole('group', { name: 'If you change nothing' })).toContainText(
    current < 0
      ? `${amount} due at tax time`
      : current > 0
        ? `A ${amount} refund at tax time`
        : 'Even at tax time',
  );

  const save = w4.getByRole('button', { name: SAVE });
  await expect(save).toBeEnabled();
  await saveVersion(page, save);
  await expect(
    w4.getByText(/^On your calendar for .+: Give your employer your updated Form W-4\.$/),
  ).toBeVisible({ timeout: 15_000 });
  await expect(w4.getByRole('link', { name: 'Why this decision' })).toHaveAttribute(
    'href',
    /^\/why\/[^/]+$/,
  );

  // Every step is saved: each is checked off in the nav, and Decisions with them.
  // Chromium reads the hidden ", done" as its own word.
  for (const name of ['Emergency fund', '401\\(k\\) match', 'Health plan', 'W-4', 'Decisions']) {
    await expect(
      page
        .getByRole('navigation', { name: 'Setup steps' })
        .getByRole('link', { name: new RegExp(`^${name}\\s*, done$`) }),
    ).toBeVisible({ timeout: 30_000 });
  }
  await expect(page.getByRole('link', { name: 'Back to health plan' })).toHaveAttribute(
    'href',
    '/setup/decisions/health-plan',
  );
  await page.getByRole('link', { name: 'See your plan' }).click();
  await expect(page).toHaveURL('/plan');
});

/**
 * Save the e2e user's profile with another pay schedule, the way the plan
 * details form used to copy an older stub's schedule into it (issue 198). The
 * token is the one the app itself sends with its `GET /profile`.
 */
async function saveProfileSchedule(page: Page, payFrequency: string) {
  const read = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/profile' && response.request().method() === 'GET',
    { timeout: 30_000 },
  );
  await page.goto('/setup/decisions/401k');
  const response = await read;
  const { authorization } = await response.request().allHeaders();
  // The profile as PUT /profile takes it: what GET adds on read stays out.
  const {
    updated_at: _updatedAt,
    pay_schedule: _paySchedule,
    ...fields
  } = (await response.json()) as Record<string, unknown>;
  const put = await page.request.put(`${e2eApiUrl()}/profile`, {
    headers: { authorization: authorization! },
    data: { ...fields, pay_frequency: payFrequency },
  });
  expect(put.ok(), await put.text()).toBe(true);
}

test("uses the confirmed pay stub's pay schedule on every step (issue 198)", async ({ page }) => {
  test.setTimeout(120_000);
  // Plan details saved while an older stub said every two weeks; the Acme stub
  // Confirm confirmed since is paid twice a month, 24 paychecks a year.
  await saveProfileSchedule(page, 'biweekly');

  await page.goto('/setup/decisions/emergency-fund');
  await waitForHydration(page);
  const fund = page.getByRole('region', { name: 'Emergency fund' });
  await expect(fund.getByLabel('Monthly transfer to savings')).toBeVisible({ timeout: 30_000 });
  await fund.getByLabel('Essential spending per month').fill('1,800.00');
  await fund.getByLabel('Saved so far').fill('2,000.00');
  await fund.getByLabel('Monthly transfer to savings').fill('300.00');
  const fundResult = fund.getByRole('group', { name: 'Your numbers' });
  await expect(fundResult).not.toHaveAttribute('aria-busy', 'true', { timeout: 15_000 });
  await expect(fundResult).toContainText('Per paycheck, 24 paychecks a year');

  await page.goto('/setup/decisions/w4');
  await waitForHydration(page);
  const w4 = page.getByRole('region', { name: 'W-4, federal only' });
  const w4Result = w4.getByRole('group', { name: 'Your numbers' });
  await expect(w4Result).toContainText(/at tax time/, { timeout: 30_000 });
  await expect(w4Result.getByRole('group', { name: 'If you change nothing' })).toBeVisible();
  await expect(w4Result).toContainText('24 paychecks');
});

/** The page as a step link's landing scrolls it to the top (`landAtTopIfRequested`). */
interface AtLanding {
  path: string;
  heading: string;
  scrollY: number;
  /** The top of the new page's root node, the first in `<main>`: what Next measures. */
  top: number;
  viewport: number;
  scrollPaddingTop: number;
}

/**
 * Record the page each time it is scrolled with `window.scrollTo`. On a step
 * link that is `landAtTopIfRequested`, in the new page's layout effect: the
 * commit Next's own scroll check runs in, with the browser's clamped offset
 * and the new page in the DOM, just before it scrolls.
 */
function recordLandings(page: Page) {
  return page.addInitScript(() => {
    const landings: AtLanding[] = [];
    (window as unknown as { __landings: AtLanding[] }).__landings = landings;
    const scrollTo = window.scrollTo.bind(window);
    window.scrollTo = ((...args: Parameters<typeof window.scrollTo>) => {
      const html = document.documentElement;
      const root = document.querySelector('main')?.firstElementChild;
      landings.push({
        path: location.pathname,
        heading: document.querySelector('main h1')?.textContent ?? '',
        scrollY: window.scrollY,
        top: root?.getBoundingClientRect().top ?? Number.NaN,
        viewport: html.clientHeight,
        scrollPaddingTop: parseFloat(getComputedStyle(html).scrollPaddingTop) || 0,
      });
      scrollTo(...args);
    }) as typeof window.scrollTo;
  });
}

test.describe('in a short window', () => {
  /*
   * Issue 172 shows only when the clamp leaves the new page's top edge in view;
   * at 1280 wide that is a window about 625 to 675px tall (a scan on November 1).
   * The test checks that this window still shows it, so it cannot pass vacuously.
   */
  test.use({ viewport: { width: 1280, height: 650 } });

  test('a step footer link lands at the top of the next step (issue 172)', async ({ page }) => {
    test.setTimeout(120_000);
    await recordLandings(page);
    // From the bottom of a longer step to a shorter one, where the browser keeps
    // part of the old scroll offset while the new step loads.
    const steps = [
      ['/setup/decisions/emergency-fund', /^Next: 401\(k\) match/],
      ['/setup/decisions/health-plan', /^Back to 401\(k\) match/],
    ] as const;
    const scrollY = () => page.evaluate(() => window.scrollY);
    for (const [from, name] of steps) {
      await page.goto(from);
      await waitForHydration(page);
      const link = page.getByRole('link', { name });
      await expect(link).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 30_000 });
      await link.scrollIntoViewIfNeeded();
      expect(await scrollY()).toBeGreaterThan(0);

      await link.click();
      await expect(page).toHaveURL('/setup/decisions/401k');
      await settled(page);
      expect(await scrollY(), `following the footer from ${from}`).toBe(0);

      // It landed at the top from the state Next leaves alone: the new page in
      // the DOM, scrolled down, its top edge in view. Without that, 0 proves nothing.
      const landings = await page.evaluate(
        () => (window as unknown as { __landings: AtLanding[] }).__landings,
      );
      const landing = landings.find((at) => at.path === '/setup/decisions/401k');
      const reproduces =
        landing !== undefined &&
        landing.heading === 'How much to put in your 401(k)' &&
        landing.scrollY > 0 &&
        landing.top >= landing.scrollPaddingTop &&
        landing.top <= landing.viewport;
      expect(
        reproduces,
        'this window no longer reproduces issue 172 (spec 018 rule 6a); rescan the window ' +
          `height. From ${from}, as the page landed: ${JSON.stringify(landing ?? 'no landing')}`,
      ).toBe(true);
    }
  });
});
