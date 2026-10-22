import path from 'node:path';
import { expect, test } from '@playwright/test';
import { openLink } from './support/api';
import { e2eUser, NO_E2E_USER, SIGNED_OUT, waitForHydration } from './support/auth';
import { CAPTURE_DIR, DESKTOP, NO_CAPTURE_DIR, PHONE, settled, shot } from './support/capture';

/*
 * The sign-in screen, the linked accounts with the uploaded pay stub, and the
 * Confirm screen at both widths; then confirms the stub so the decisions can
 * be made over it. Serial. The bank must already be linked (capture-link, or
 * the API's sandbox route).
 */
test.describe.configure({ mode: 'serial' });
test.skip(!CAPTURE_DIR, NO_CAPTURE_DIR);
test.skip(!e2eUser(), NO_E2E_USER);

const FIXTURE = path.join(__dirname, 'fixtures', 'acme-paystub.pdf');

/** What the Acme stub prints, by field label, typed in when no model read it. */
const ACME: Record<string, string> = {
  Employer: 'Acme Corp',
  'Pay date': '2026-10-15',
  'Period start': '2026-10-01',
  'Period end': '2026-10-15',
  'Pay frequency': 'semimonthly',
  'Gross pay': '2,708.33',
  'Federal income tax': '297.76',
  'Social Security': '167.92',
  Medicare: '39.27',
  'State income tax': '98.14',
  '401(k) contribution': '0',
  'Medical premium': '62.50',
  'Other deductions': '46.70',
  'Net pay': '1,996.04',
};

test('01 the sign-in screen', async ({ browser }) => {
  const context = await browser.newContext({ storageState: SIGNED_OUT, viewport: DESKTOP });
  const page = await context.newPage();
  await page.goto('/sign-in');
  await waitForHydration(page);
  await shot(page, '01-sign-in');
  await context.close();
});

test('03 the linked accounts with the uploaded pay stub', async ({ page }) => {
  await openLink(page);
  await expect(page.getByRole('group', { name: 'Plaid Checking' })).toBeVisible();
  const checking = page.getByRole('group', { name: 'Plaid Checking' });
  const saving = page.getByRole('group', { name: 'Plaid Saving' });
  await checking.getByRole('combobox', { name: 'Role' }).selectOption('Spending');
  await saving.getByRole('combobox', { name: 'Role' }).selectOption('Emergency fund');

  // A stub already waiting for review is reused; otherwise the Acme stub is
  // uploaded and read by the worker.
  const docs = page.getByRole('region', { name: 'Documents' });
  const rows = docs.getByRole('group', { name: /^Pay stub/ });
  await expect(rows.first().or(docs.getByText(/^No documents yet/))).toBeVisible({
    timeout: 30_000,
  });
  const reviewable = rows
    .filter({ hasText: /Review needed|Manual entry needed/ })
    .first()
    .getByText(/^(Review needed|Manual entry needed)$/);
  if ((await reviewable.count()) === 0) {
    test.setTimeout(test.info().timeout + 180_000);
    await docs.getByLabel('Document type').selectOption('pay_stub');
    await docs.getByLabel(/Add (another|a) document/).setInputFiles(FIXTURE);
  }
  await expect(reviewable).toBeVisible({ timeout: 180_000 });
  await settled(page);
  await shot(page, '03-link-linked');
});

test('06 and 15 the Confirm screen, then confirming the stub', async ({ page }) => {
  await openLink(page);
  const docs = page.getByRole('region', { name: 'Documents' });
  const row = docs
    .getByRole('group', { name: /^Pay stub/ })
    .filter({ hasText: /Review needed|Manual entry needed/ })
    .first();
  await row.getByRole('link').first().click();
  await expect(page).toHaveURL(/\/setup\/confirm\/[^/]+$/);
  await settled(page);
  await shot(page, '06-confirm-review');
  await page.setViewportSize(PHONE);
  await settled(page);
  await shot(page, '15-confirm-phone');
  await page.setViewportSize(DESKTOP);

  const fields = page.getByRole('region', { name: /^(Extracted fields|Pay stub fields)$/ });
  // Manual entry (no model read the stub): every row is open with a "Save and
  // confirm" button; type what the stub prints into each.
  const manual = fields.getByRole('button', { name: /^Save and confirm / });
  while ((await manual.count()) > 0) {
    const label = ((await manual.first().getAttribute('aria-label')) ?? '').replace(
      /^Save and confirm /,
      '',
    );
    const group = fields.getByRole('group', { name: label, exact: true });
    const control = group.getByLabel(label, { exact: true });
    if (label === 'Pay frequency') await control.selectOption({ label: 'Twice a month' });
    else await control.fill(ACME[label] ?? '0');
    await group.getByRole('button', { name: `Save and confirm ${label}`, exact: true }).click();
    await expect(
      fields.getByRole('button', { name: `Confirmed ${label}`, exact: true }),
    ).toBeVisible();
  }
  // A proposal (a model read it): confirm the rows it filled, type the rest.
  const confirmAll = page.getByRole('button', { name: 'Confirm all remaining' });
  if ((await confirmAll.count()) > 0 && (await confirmAll.isEnabled())) await confirmAll.click();
  const unconfirmed = fields.getByRole('button', { name: /^Confirm (?!all)/ });
  while ((await unconfirmed.count()) > 0) {
    const label = ((await unconfirmed.first().getAttribute('aria-label')) ?? '').replace(
      /^Confirm /,
      '',
    );
    const edit = fields.getByRole('button', { name: `Edit ${label}`, exact: true });
    if (await edit.isVisible()) await edit.click();
    const input = fields
      .getByRole('group', { name: label, exact: true })
      .getByLabel(label, { exact: true });
    if ((await input.inputValue()) === '') await input.fill(ACME[label] ?? '0');
    await input.press('Enter');
    await expect(
      fields.getByRole('button', { name: `Confirmed ${label}`, exact: true }),
    ).toBeVisible();
  }
  await expect(fields.getByText('The math checks out.')).toBeVisible();
  await page.getByRole('button', { name: /Confirm and continue/ }).click();
  await expect(page).toHaveURL('/setup/spending', { timeout: 30_000 });
});
