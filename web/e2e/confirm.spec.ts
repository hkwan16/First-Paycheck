import path from 'node:path';
import { expect, test } from '@playwright/test';
import { e2eApiUrl, NO_E2E_API, openLink } from './support/api';
import { e2eUser, NO_E2E_USER, waitForHydration } from './support/auth';

/*
 * Upload, read, review and confirm a pay stub against the real API with the
 * saved e2e session. The file is synthetic (e2e/fixtures/make-acme-paystub.mjs):
 * an example SSN the API must redact, and a masked account number. The API's
 * worker reads it (FakeGateway in a test environment, Sonnet otherwise).
 */

const FIXTURE = path.join(__dirname, 'fixtures', 'acme-paystub.pdf');

test.describe.configure({ mode: 'serial' });
test.skip(!e2eUser(), NO_E2E_USER);
test.skip(!e2eApiUrl(), NO_E2E_API);

test('uploads a pay stub, reviews every field and continues to Spending', async ({ page }) => {
  test.setTimeout(240_000);
  await openLink(page);
  const docs = page.getByRole('region', { name: 'Documents' });
  await docs.getByLabel('Document type').selectOption('pay_stub');
  await docs.getByLabel(/Add (another|a) document/).setInputFiles(FIXTURE);

  // Newest first: the upload is the first pay stub row once it lands.
  const row = docs.getByRole('group', { name: /^Pay stub/ }).first();
  await expect(row.getByText('Review needed')).toBeVisible({ timeout: 180_000 });
  await expect(row.getByText(/^[1-9]\d* items? redacted$/)).toBeVisible();

  await row.getByRole('link', { name: 'Review pay stub' }).click();
  await expect(page).toHaveURL(/\/setup\/confirm\/[^/]+$/);
  await waitForHydration(page);
  const fields = page.getByRole('region', { name: 'Extracted fields' });
  await expect(fields).toBeVisible();
  await expect(
    page.getByRole('complementary', { name: 'Source, as the AI saw it' }).getByRole('img', {
      name: 'Redacted',
    }),
  ).not.toHaveCount(0);

  await page.getByRole('button', { name: 'Confirm all remaining' }).click();

  // A field the stub does not print (the 401(k) line is a dash) stays open;
  // type what the stub says for each one left.
  const unconfirmed = fields.getByRole('button', { name: /^Confirm (?!all)/ });
  while ((await unconfirmed.count()) > 0) {
    const label = ((await unconfirmed.first().getAttribute('aria-label')) ?? '').replace(
      /^Confirm /,
      '',
    );
    await fields.getByRole('button', { name: `Edit ${label}`, exact: true }).click();
    const input = fields
      .getByRole('group', { name: label, exact: true })
      .getByLabel(label, { exact: true });
    if ((await input.inputValue()) === '') await input.fill('0');
    await input.press('Enter');
    await expect(
      fields.getByRole('button', { name: `Confirmed ${label}`, exact: true }),
    ).toBeVisible();
  }

  await expect(fields.getByText('The math checks out.')).toBeVisible();
  await page.getByRole('button', { name: /Confirm and continue/ }).click();
  await expect(page).toHaveURL('/setup/spending', { timeout: 30_000 });
  await expect(
    page.getByRole('heading', { level: 1, name: 'Where your money went' }),
  ).toBeVisible();
});
