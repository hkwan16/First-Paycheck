import { expect, test, type Locator, type Page } from '@playwright/test';
import { e2eApiUrl, NO_E2E_API, openLink } from './support/api';
import { e2eUser, NO_E2E_USER } from './support/auth';

/*
 * Import a CSV on the Link screen against the real API (spec 010 part B):
 * e2e/fixtures/bank-export.csv is a synthetic five-row export in the
 * bank convention (money out is negative), with a running balance. The
 * project runs after Spending, which link.spec.ts starts from a clean slate
 * (unlinking everything, CSV accounts included), so the first test makes a
 * new account; run on its own it adds to the one an earlier run made.
 */

const FIXTURE = 'e2e/fixtures/bank-export.csv';
const ACCOUNT = 'E2E CSV Checking';
const BANK = 'E2E Credit Union';
const ROWS = 5;

test.describe.configure({ mode: 'serial' });
test.skip(!e2eUser(), NO_E2E_USER);
test.skip(!e2eApiUrl(), NO_E2E_API);

async function openImport(page: Page) {
  await openLink(page);
  await page.getByRole('button', { name: 'Import a CSV' }).click();
  return page.getByRole('region', { name: 'Import a CSV' });
}

/** Both follow-up jobs (categorizing, finding recurring charges) report Done. */
async function expectJobsDone(panel: Locator) {
  for (const label of ['Labeling categories', 'Finding recurring charges']) {
    await expect(panel.getByRole('progressbar', { name: label })).toBeVisible();
  }
  await expect(panel.getByText('Done', { exact: true })).toHaveCount(2, { timeout: 90_000 });
}

test('imports the export into a new account and follows both jobs', async ({ page }) => {
  const panel = await openImport(page);
  const existing = page.getByRole('group', { name: ACCOUNT });
  if ((await existing.count()) > 0) {
    await panel.getByLabel('Import into').selectOption({ label: ACCOUNT });
  } else {
    await panel.getByLabel('Account type').selectOption('Checking');
    await panel.getByLabel('Account name (optional)').fill(ACCOUNT);
    await panel.getByLabel('Bank name (optional)').fill(BANK);
  }
  await panel.getByLabel(/Choose a CSV file/).setInputFiles(FIXTURE);
  await panel.getByRole('button', { name: 'Import CSV' }).click();

  await expect(panel.getByText(`Imported ${ROWS} transactions into ${ACCOUNT}.`)).toBeVisible({
    timeout: 30_000,
  });
  await expectJobsDone(panel);
  await expect(page.getByRole('group', { name: ACCOUNT })).toHaveCount(1);
});

test('importing the same file again adds no second account', async ({ page }) => {
  const panel = await openImport(page);
  await panel.getByLabel('Import into').selectOption({ label: ACCOUNT });
  await expect(panel.getByLabel('Account type')).toHaveCount(0);
  await panel.getByLabel(/Choose a CSV file/).setInputFiles(FIXTURE);
  await panel.getByRole('button', { name: 'Import CSV' }).click();

  await expect(
    panel.getByText(new RegExp(`^Imported \\d+ transactions? into ${ACCOUNT}\\.$`)),
  ).toBeVisible({ timeout: 30_000 });
  await expectJobsDone(panel);
  await expect(page.getByRole('group', { name: ACCOUNT })).toHaveCount(1);
});

test('a file with bad rows lists them and imports nothing', async ({ page }) => {
  const panel = await openImport(page);
  await panel.getByLabel('Import into').selectOption({ label: ACCOUNT });
  await panel.getByLabel(/Choose a CSV file/).setInputFiles({
    name: 'broken-export.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'Date,Description,Amount\n2026-13-01,BAD DATE,-1.00\n2026-09-03,,-2.00\n2026-09-04,TOO PRECISE,-1.005\n',
    ),
  });
  await panel.getByRole('button', { name: 'Import CSV' }).click();

  const alert = panel.getByRole('alert');
  await expect(alert).toContainText('Nothing was imported.', { timeout: 30_000 });
  const rows = alert.getByRole('listitem');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveText(/^Row 2, date: /);
  await expect(rows.nth(1)).toHaveText(/^Row 3, description: /);
  await expect(rows.nth(2)).toHaveText(/^Row 4, amount: /);
});
