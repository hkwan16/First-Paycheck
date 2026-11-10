import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { e2eApiUrl, NO_E2E_API, openLink } from './support/api';
import { e2eUser, NO_E2E_USER, waitForHydration } from './support/auth';

/*
 * Upload, read, review and confirm a pay stub against the real API with the
 * saved e2e session. The file is synthetic (e2e/fixtures/make-acme-paystub.mjs):
 * an example SSN the API must redact, and a masked account number. The API's
 * worker reads it (FakeGateway in a test environment, Sonnet otherwise).
 */

const FIXTURE = path.join(__dirname, 'fixtures', 'acme-paystub.pdf');

/**
 * Confirm every field with "Confirm all remaining" alone and continue. Every
 * line the Acme stub prints is read, its 401(k) dash as $0.00 (issue 195), so
 * nothing is left to type.
 */
async function confirmEveryField(page: Page, fields: Locator) {
  await page.getByRole('button', { name: 'Confirm all remaining' }).click();

  await expect(fields.getByRole('button', { name: /^Confirm (?!all)/ })).toHaveCount(0);
  await expect(fields.getByText('The math checks out.')).toBeVisible();
  await page.getByRole('button', { name: /Confirm and continue/ }).click();
}

test.describe.configure({ mode: 'serial' });
test.skip(!e2eUser(), NO_E2E_USER);
test.skip(!e2eApiUrl(), NO_E2E_API);

test('the documents card says it is loading until the list arrives (issue 196)', async ({
  page,
}) => {
  // Hold the first read of the list, as a slow API would.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    (url) => url.pathname === '/docs',
    async (route) => {
      if (route.request().method() === 'GET') await held;
      await route.continue();
    },
  );
  await page.goto('/setup/link');
  await waitForHydration(page);
  const docs = page.getByRole('region', { name: 'Documents' });
  await expect(docs.getByText('Loading your documents')).toBeAttached();
  await expect(docs.getByText(/^No documents yet/)).toHaveCount(0);

  release();
  await expect(docs.getByText('Loading your documents')).toHaveCount(0, { timeout: 60_000 });
  await page.unrouteAll({ behavior: 'wait' });
});

test('uploads a pay stub, replaces it, reviews every field and continues to Spending', async ({
  page,
}) => {
  test.setTimeout(360_000);
  await openLink(page);
  const docs = page.getByRole('region', { name: 'Documents' });
  await docs.getByLabel('Document type').selectOption('pay_stub');
  await docs.getByLabel(/Add (another|a) document/).setInputFiles(FIXTURE);

  // Newest first: the upload is the first pay stub row once it lands.
  const row = docs.getByRole('group', { name: /^Pay stub/ }).first();
  await expect(row.getByText('Review needed')).toBeVisible({ timeout: 180_000 });

  // Replace it through the row's own file picker: the new upload retires the
  // old document (spec 004 rule 24), so its row leaves the list.
  const replaced = await row.getByRole('link', { name: 'Review pay stub' }).getAttribute('href');
  expect(replaced).toMatch(/^\/setup\/confirm\/[^/]+$/);
  const chooser = page.waitForEvent('filechooser');
  await row.getByRole('button', { name: 'Replace pay stub' }).click();
  await (await chooser).setFiles(FIXTURE);
  await expect(docs.locator(`a[href="${replaced}"]`)).toHaveCount(0, { timeout: 60_000 });
  await expect(row.getByText('Review needed')).toBeVisible({ timeout: 180_000 });
  await expect(row.getByRole('link', { name: 'Review pay stub' })).not.toHaveAttribute(
    'href',
    replaced!,
  );
  await expect(row.getByText(/^[1-9]\d* numbers? hidden$/)).toBeVisible();

  await row.getByRole('link', { name: 'Review pay stub' }).click();
  await expect(page).toHaveURL(/\/setup\/confirm\/[^/]+$/);
  await waitForHydration(page);
  const fields = page.getByRole('region', { name: 'What we read' });
  await expect(fields).toBeVisible();
  await expect(page).toHaveTitle('Confirm pay stub | First Paycheck');
  await expect(
    page.getByRole('complementary', { name: 'Your pay stub' }).getByRole('img', {
      name: 'Hidden number',
    }),
  ).not.toHaveCount(0);

  // The stub prints "401(k) -": a dash on a deduction line is $0.00, read from
  // that line (issue 195), so selecting the field marks it in the source.
  const k401 = fields.getByRole('group', { name: '401(k) contribution', exact: true });
  await expect(k401.getByText('$0.00', { exact: true })).toBeVisible();
  await k401.getByRole('button', { name: /^401\(k\) contribution/ }).click();
  await expect(page.locator('li[aria-current="true"]')).toHaveText(/^401\(k\)\s*-$/);

  await confirmEveryField(page, fields);
  await expect(page).toHaveURL('/setup/spending', { timeout: 30_000 });
  // "Where your money went" while the cash flow loads, then the period's month.
  await expect(
    page.getByRole('heading', { level: 1, name: /^Where (your|\w+'s) money went$/ }),
  ).toBeVisible();
});

// The Acme stub's pay period, which the Spending period picker must still offer.
const ACME_MONTH = 'October 2026';

test('confirming the same pay stub again counts it once on Spending (issue 190)', async ({
  page,
}) => {
  test.setTimeout(360_000);
  // A second upload of the same file, not a Replace: what a person does when
  // they forget they already confirmed it. Before issue 190 October then read
  // "2 pay stubs" and "Gross pay, 2 stubs $5,416.66".
  await openLink(page);
  const docs = page.getByRole('region', { name: 'Documents' });
  await docs.getByLabel('Document type').selectOption('pay_stub');
  await docs.getByLabel(/Add (another|a) document/).setInputFiles(FIXTURE);
  const row = docs.getByRole('group', { name: /^Pay stub/ }).first();
  await expect(row.getByText('Review needed')).toBeVisible({ timeout: 180_000 });
  await row.getByRole('link', { name: 'Review pay stub' }).click();
  await waitForHydration(page);
  await confirmEveryField(page, page.getByRole('region', { name: 'What we read' }));
  await expect(page).toHaveURL('/setup/spending', { timeout: 30_000 });
  await waitForHydration(page);

  // Exact: after the client-side navigation Next keeps the Confirm page in the
  // DOM, hidden, and its "Period start" and "Period end" rows match "Period".
  const picker = page.getByLabel('Period', { exact: true });
  await expect(picker).toBeEnabled({ timeout: 60_000 });
  const months = await picker.locator('option').allTextContents();
  expect(
    months,
    `The Acme stub is paid in ${ACME_MONTH}, which the period picker no longer offers; ` +
      'move the fixture (make-acme-paystub.mjs) and this test to a recent month.',
  ).toContain(ACME_MONTH);
  await picker.selectOption({ label: ACME_MONTH });

  // The confirmed copies of the stub are one paycheck: one stub, its pay once.
  await expect(page.getByRole('region', { name: /· 1 pay stub$/ })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole('button', { name: 'Gross pay, 1 stub $2,708.33' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Federal tax $297.76' })).toBeVisible();

  // On Link the newest copy is the confirmed one; the copy it replaced says
  // so and offers nothing to do again (issue 199).
  await openLink(page);
  const stubs = page
    .getByRole('region', { name: 'Documents' })
    .getByRole('group', { name: /^Pay stub/ });
  await expect(stubs.first().getByText('Confirmed', { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  const older = stubs.filter({ hasText: 'Replaced by a newer copy' }).first();
  await expect(older).toContainText('You confirmed this paycheck again, so the newer copy counts.');
  await expect(older.getByText('Confirmed', { exact: true })).toHaveCount(0);
  await expect(older.getByRole('button', { name: 'Replace pay stub' })).toHaveCount(0);

  // Each confirmed copy is named by its employer and pay date and opens what was
  // confirmed from it, read-only (issue 243).
  const newest = stubs.first();
  await expect(newest).toHaveAccessibleName('Pay stub · Acme Corp, paid Oct 15, 2026');
  await newest.getByRole('link', { name: 'View pay stub' }).click();
  await waitForHydration(page);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Your pay stub is confirmed' }),
  ).toBeVisible();
  const confirmedValues = page.getByRole('region', { name: 'What you confirmed' });
  await expect(confirmedValues).toContainText('Acme Corp');
  await expect(confirmedValues).toContainText('$2,708.33');
  await expect(confirmedValues).toContainText('$1,996.04');
  await expect(confirmedValues.getByRole('button')).toHaveCount(0);
});

const NO_401K = path.join(__dirname, 'fixtures', 'no-401k-paystub.pdf');

test('a stub with no 401(k) line confirms it as none, and the review survives a reload (issues 229, 230)', async ({
  page,
}) => {
  test.setTimeout(360_000);
  await openLink(page);
  const docs = page.getByRole('region', { name: 'Documents' });
  await docs.getByLabel('Document type').selectOption('pay_stub');
  await docs.getByLabel(/Add (another|a) document/).setInputFiles(NO_401K);
  const row = docs.getByRole('group', { name: /^Pay stub/ }).first();
  await expect(row.getByText('Review needed')).toBeVisible({ timeout: 180_000 });
  await row.getByRole('link', { name: 'Review pay stub' }).click();
  await expect(page).toHaveURL(/\/setup\/confirm\/[^/]+$/);
  await waitForHydration(page);
  const fields = page.getByRole('region', { name: 'What we read' });
  await expect(fields).toContainText('0 of 14 confirmed');

  // Nothing was read for the 401(k): never "Read clearly", and one step says none.
  const k401 = fields.getByRole('group', { name: '401(k) contribution', exact: true });
  await expect(k401).toContainText('Not found');
  await expect(k401).toContainText('If your stub has no such line, confirm none.');
  await expect(k401.getByText('Read clearly')).toHaveCount(0);
  await k401.getByRole('button', { name: 'Confirm none for 401(k) contribution' }).click();
  await expect(k401.getByText('$0.00', { exact: true })).toBeVisible();
  await expect(k401.getByText('Your entry')).toBeVisible();

  // A typed amount is the person's, not "Read clearly". Gross and net both
  // one cent up still balance.
  const gross = fields.getByRole('group', { name: 'Gross pay', exact: true });
  await gross.getByRole('button', { name: 'Edit Gross pay' }).click();
  await gross.getByRole('textbox', { name: 'Gross pay' }).fill('2,615.39');
  await gross.getByRole('textbox', { name: 'Gross pay' }).press('Enter');
  await expect(gross.getByText('Your entry')).toBeVisible();
  await expect(gross.getByText('Read clearly')).toHaveCount(0);
  const net = fields.getByRole('group', { name: 'Net pay', exact: true });
  await net.getByRole('button', { name: 'Edit Net pay' }).click();
  await net.getByRole('textbox', { name: 'Net pay' }).fill('1,878.05');
  await net.getByRole('textbox', { name: 'Net pay' }).press('Enter');
  await page.getByRole('button', { name: 'Confirm all remaining' }).click();
  await expect(fields).toContainText('14 of 14 confirmed');
  await expect(fields.getByText('The math checks out.')).toBeVisible();

  // Every change is kept with the document (issue 229), so a reload loses
  // nothing. The render that shows a change already says it is saving.
  await expect(fields).toContainText('14 of 14 confirmed · Progress saved');
  await page.reload();
  await waitForHydration(page);
  await expect(fields).toContainText('14 of 14 confirmed');
  await expect(gross).toContainText('$2,615.39');
  await expect(gross.getByText('Your entry')).toBeVisible();
  await expect(net).toContainText('$1,878.05');
  await expect(k401.getByText('$0.00', { exact: true })).toBeVisible();
  await expect(fields.getByText('The math checks out.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Confirm and continue/ })).toBeEnabled();
  // Left in review: confirming a September stub would change what the later
  // projects (decisions, check-in) read as the e2e user's paychecks.
});
