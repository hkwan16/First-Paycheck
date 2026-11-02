import { expect, test } from '@playwright/test';
import { e2eUser, NO_E2E_USER } from './support/auth';
import { CAPTURE_DIR, NO_CAPTURE_DIR, settled, shot } from './support/capture';

/*
 * Spending, Decisions, Why, Plan and the check-in screens, over the data the
 * capture-setup and real-API projects made. Serial, in the document's order.
 */
test.describe.configure({ mode: 'serial' });
test.skip(!CAPTURE_DIR, NO_CAPTURE_DIR);
test.skip(!e2eUser(), NO_E2E_USER);

test('04, 05, 07 and 08 the Spending screen', async ({ page }) => {
  await page.goto('/setup/spending');
  await settled(page);
  // The period with the confirmed stub: the capture confirms the Acme stub,
  // paid October 15, so the diagram draws its withholding for October.
  const picker = page.getByRole('combobox', { name: 'Period' });
  const october = picker.locator('option', { hasText: /^Oct/ });
  if ((await october.count()) > 0) {
    await picker.selectOption({ label: (await october.first().textContent()) ?? '' });
    await settled(page);
  }
  const table = page.getByRole('table', { name: 'Transactions' });
  await expect(table.getByRole('row').nth(1)).toBeVisible({ timeout: 60_000 });
  const summary = page.getByRole('region', {
    name: /^\w+ \d+.* to .+ · (\d+ pay stubs?|no pay stub)$/,
  });
  await shot(summary, '07-spending-tiles');

  const card = page.getByRole('region', { name: /^Where each dollar of (\w+ )?pay went$/ });
  if ((await card.getByRole('button').count()) > 0) {
    await card.getByRole('button').first().hover();
    await expect(card.getByRole('group')).toHaveCount(1);
    await page.waitForTimeout(400);
    await shot(card, '08-spending-sankey');
    await page.keyboard.press('Escape');
  } else {
    await shot(card, '08-spending-sankey');
  }

  const transactions = page.getByRole('region', { name: 'Transactions' });
  await shot(transactions, '04-spending-transactions');

  // A fix is a rule for its merchant, which never goes back to the AI. Fix a
  // merchant an earlier run fixed ("You") when there is one, so reruns do not
  // take the AI's labels away one merchant at a time; it toggles between two
  // categories, as spending.spec.ts does.
  const rows = table.getByRole('row');
  const yours = rows.filter({ has: page.getByText('You', { exact: true }) });
  const select = ((await yours.count()) > 0 ? yours : rows.nth(1)).getByRole('combobox').first();
  const target = (await select.inputValue()) === 'entertainment' ? 'Dining' : 'Entertainment';
  await select.selectOption(target);
  await expect(page.getByText(/^Saved as a rule\./)).toBeVisible({ timeout: 15_000 });
  await shot(transactions, '05-spending-rule-notice');
});

test('09, 10 and 11 the Decisions and Why screens', async ({ page }) => {
  await page.goto('/setup/decisions/401k');
  await settled(page);
  const card = page.getByRole('region', { name: '401(k) match' });
  const slider = card.getByRole('slider', { name: /Your contribution/ });
  await expect(slider).toBeVisible({ timeout: 60_000 });
  const save = card.getByRole('button', { name: /^Save|^Saved as v/ });
  await expect(save).toHaveText(/^Saved as v\d+/, { timeout: 30_000 });
  await shot(card, '09-decisions-v1');

  const value = Number(await slider.inputValue());
  await slider.fill(String(value === 4 ? 5 : 4));
  await expect(card.getByText(/^Changed since v/)).toBeVisible({ timeout: 30_000 });
  await expect(save).toBeEnabled({ timeout: 30_000 });
  await save.click();
  await expect(save).toHaveText(/^Saved as v\d+/, { timeout: 30_000 });
  await shot(card, '10-decisions-v2');

  await card.getByRole('link', { name: 'Why this decision' }).click();
  await expect(page).toHaveURL(/\/why\/[^/]+$/);
  await settled(page);
  // The new version has no explanation yet: write it and wait for its answer
  // (verified with a model, the calculator's result if the verifier refused
  // the draft, or "not available" without a model).
  const none = page.getByRole('region', { name: 'No explanation yet' });
  const verified = page.getByText(/^We checked every number here/);
  const fallback = page.getByText(/^We could not write an explanation/);
  await expect(verified.or(fallback).or(none)).toBeVisible({ timeout: 60_000 });
  if (await none.isVisible()) {
    await none.getByRole('button', { name: 'Write the explanation' }).click();
    await expect(
      verified.or(fallback).or(page.getByText('Explanations are not available right now.')),
    ).toBeVisible({ timeout: 180_000 });
    await settled(page);
  }
  await shot(page, '11-why-verified');
});

test('12 the Plan screen', async ({ page }) => {
  await page.goto('/plan');
  await settled(page);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await shot(page, '12-plan');
});

test('13 and 14 a check-in, and the list after Check in now', async ({ page }) => {
  await page.goto('/check-in');
  await settled(page);
  await page.getByRole('button', { name: 'Check in now' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: /check-in|checked|up to date/i }),
  ).toBeVisible({ timeout: 120_000 });
  await settled(page);
  await shot(page, '14-check-in-now');

  const open = page.getByRole('link', { name: 'Open it' });
  if (await open.isVisible()) await open.click();
  else await page.getByRole('list', { name: 'Check-ins' }).getByRole('link').first().click();
  await expect(page.getByRole('heading', { level: 1, name: /check-in$/ })).toBeVisible({
    timeout: 30_000,
  });
  await settled(page);
  await shot(page, '13-check-in');
});
