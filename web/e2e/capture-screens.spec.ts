import { expect, test } from '@playwright/test';
import { e2eUser, NO_E2E_USER } from './support/auth';
import { CAPTURE_DIR, DESKTOP, NO_CAPTURE_DIR, PHONE, settled, shot } from './support/capture';

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
  const table = page.getByRole('table', { name: 'Transactions' });
  await expect(table.getByRole('row').nth(1)).toBeVisible({ timeout: 60_000 });
  const summary = page.getByRole('region', { name: /^\w+ \d+.* to .+ · \d+ paychecks?$/ });
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

  const select = table.getByRole('combobox').first();
  const current = await select.inputValue();
  const options = await select
    .locator('option')
    .evaluateAll((all) => all.map((o) => (o as HTMLOptionElement).value));
  const target = options.find((o) => o && o !== current) ?? current;
  await select.selectOption(target);
  await expect(page.getByText(/^Saved as a rule\./)).toBeVisible({ timeout: 15_000 });
  await shot(transactions, '05-spending-rule-notice');
});

test('09, 10, 11 and 16 the Decisions and Why screens', async ({ page }) => {
  await page.goto('/setup/decisions');
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

  await page.setViewportSize(PHONE);
  await settled(page);
  await shot(page, '16-decisions-phone');
  await page.setViewportSize(DESKTOP);

  await card.getByRole('link', { name: 'Why this decision' }).click();
  await expect(page).toHaveURL(/\/why\/[^/]+$/);
  await settled(page);
  const write = page.getByRole('button', { name: 'Write the explanation' });
  if (await write.isVisible()) {
    await write.click();
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
