import { expect, test, type Locator, type Page } from '@playwright/test';
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
 * read the saved 401(k) rate and health premium, change Step 4(c) and save a
 * version with its reminder to hand the form in. The e2e user
 * keeps its decisions between runs (they cannot be deleted), so each test
 * reads which version is current instead of assuming v1.
 */

test.describe.configure({ mode: 'serial' });
test.skip(!e2eUser(), NO_E2E_USER);
test.skip(!e2eApiUrl(), NO_E2E_API);

const card = (page: Page) => page.getByRole('region', { name: '401(k) match' });
const result = (page: Page) => card(page).getByRole('group', { name: 'Calculator result' });
const saveButton = (page: Page) => card(page).getByRole('button', { name: /^Save|^Saved as v/ });

async function settled(page: Page) {
  await expect(result(page)).not.toHaveAttribute('aria-busy', 'true', { timeout: 15_000 });
  await expect(result(page)).toContainText(/You (capture|leave)/);
}

async function setContribution(slider: Locator, percent: number) {
  await slider.fill(String(percent));
}

test('calculates, saves a version, saves the next one over it and opens why', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/setup/decisions');
  await waitForHydration(page);
  await expect(card(page)).not.toHaveAttribute('aria-busy', 'true', { timeout: 30_000 });

  const form = card(page).getByRole('form', { name: 'Your plan details' });
  if (await form.isVisible()) {
    await form.getByLabel('Yearly salary').fill('65,000');
    await form.getByRole('button', { name: 'Single' }).click();
    await form.getByLabel('Employer adds, % of what you put in').fill('100');
    await form.getByLabel('Up to, % of your pay').fill('4');
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
  await saveButton(page).click();
  await expect(saveButton(page)).toHaveText(/^Saved as v(\d+)$/, { timeout: 15_000 });
  const saved = Number(/v(\d+)/.exec((await saveButton(page).textContent()) ?? '')![1]);

  await setContribution(slider, first === 4 ? 6 : 3);
  await settled(page);
  await expect(saveButton(page)).toHaveText(`Save as v${saved + 1}`);
  await expect(card(page).getByText(`Changed since v${saved}`)).toBeVisible();
  await saveButton(page).click();
  await expect(saveButton(page)).toHaveText(`Saved as v${saved + 1}`, { timeout: 15_000 });

  await card(page).getByRole('link', { name: 'Why this decision' }).click();
  await expect(page).toHaveURL(/\/why\/[^/]+$/);
  await waitForHydration(page);
  await expect(page.getByText(`401(k) match · decision v${saved + 1}`)).toBeVisible();

  const none = page.getByRole('region', { name: 'No explanation yet' });
  const verified = page.getByText('Verified against calculator');
  const fallback = page.getByText('Could not verify the explanation');
  await expect(verified.or(fallback).or(none)).toBeVisible({ timeout: 30_000 });
  if (await none.isVisible()) {
    await none.getByRole('button', { name: 'Write the explanation' }).click();
  }
  // Verified, a fallback, or no model configured on this API: each is an answer.
  await expect(
    verified.or(fallback).or(page.getByText('Explanations are not available yet.')),
  ).toBeVisible({ timeout: 90_000 });
});

/** The save button's version after a save: "Saved as v3" is 3. */
async function savedVersion(save: Locator) {
  await expect(save).toHaveText(/^Saved as v\d+$/, { timeout: 15_000 });
  return Number(/v(\d+)/.exec((await save.textContent()) ?? '')![1]);
}

test('saves an emergency fund version and pauses and resumes its goal', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/setup/decisions');
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
  const result = fund.getByRole('group', { name: 'Calculator result' });
  await expect(result).not.toHaveAttribute('aria-busy', 'true', { timeout: 15_000 });
  await expect(result).toContainText(`Target $5,400, reached in ${months} months`);
  const save = fund.getByRole('button', { name: /^Save|^Saved as v/ });
  await expect(save).toBeEnabled();
  await save.click();
  await savedVersion(save);

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
  await page.goto('/setup/decisions');
  await waitForHydration(page);
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
  const result = health.getByRole('group', { name: 'Calculator result' });
  await expect(result).not.toHaveAttribute('aria-busy', 'true', { timeout: 15_000 });
  await expect(result).toContainText('costs the least');

  const save = health.getByRole('button', { name: /^Save|^Saved as v/ });
  await expect(save).toBeEnabled();
  await save.click();
  await savedVersion(save);
  await expect(health.getByText(/ is on your calendar for /)).toBeVisible({
    timeout: 15_000,
  });
});

test('reads the saved decisions into the W-4 and saves a version with its reminder', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/setup/decisions');
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
  // Move away from whatever is saved, so there is a version to save.
  const extra = w4.getByLabel('Step 4(c): extra withholding each paycheck');
  await extra.fill((await extra.inputValue()) === '25.00' ? '50.00' : '25.00');

  const result = w4.getByRole('group', { name: 'Calculator result' });
  await expect(result).not.toHaveAttribute('aria-busy', 'true', { timeout: 15_000 });
  await expect(result).toContainText(/at tax time/);
  await expect(result).toContainText(/Withheld each paycheck\s*\$/);

  const save = w4.getByRole('button', { name: /^Save|^Saved as v/ });
  await expect(save).toBeEnabled();
  await save.click();
  await savedVersion(save);
  await expect(
    w4.getByText(/^Give your employer your updated Form W-4 is on your calendar for /),
  ).toBeVisible({ timeout: 15_000 });
  await expect(w4.getByRole('link', { name: 'Why this decision' })).toHaveAttribute(
    'href',
    /^\/why\/[^/]+$/,
  );
});
