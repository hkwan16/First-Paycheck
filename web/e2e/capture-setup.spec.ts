import { expect, test } from '@playwright/test';
import { openLink } from './support/api';
import { e2eUser, NO_E2E_USER, SIGNED_OUT, waitForHydration } from './support/auth';
import {
  CAPTURE_DIR,
  confirmAcmeFields,
  DESKTOP,
  NO_CAPTURE_DIR,
  proposalOf,
  settled,
  shot,
  stubRow,
  uploadAcmeStub,
} from './support/capture';

/*
 * The sign-in screen, the linked accounts with a newly uploaded pay stub, and
 * that stub's Confirm screen; then confirms it so the decisions can be made
 * over it. Serial. The bank must already be linked (the API's sandbox route).
 * Each run uploads the Acme stub and follows that document by its id, so an
 * older stub waiting for review is replaced rather than reviewed. With a
 * model the Confirm screen shows the fields it read; without one, the fields
 * to type. Either way every value is checked against what the stub prints.
 */
test.describe.configure({ mode: 'serial' });
test.skip(!CAPTURE_DIR, NO_CAPTURE_DIR);
test.skip(!e2eUser(), NO_E2E_USER);

/** The document capture-setup uploads, for the Confirm shot and the confirm. */
let documentId = '';

test('01 the sign-in screen', async ({ browser }) => {
  const context = await browser.newContext({ storageState: SIGNED_OUT, viewport: DESKTOP });
  const page = await context.newPage();
  await page.goto('/sign-in');
  await waitForHydration(page);
  await shot(page, '01-sign-in');
  await context.close();
});

test('03 the linked accounts with the uploaded pay stub', async ({ page }) => {
  test.setTimeout(test.info().timeout + 240_000);
  await openLink(page);
  // The bank is linked beforehand (the API's sandbox route); its roles are the account's own.
  await expect(
    page.getByRole('region', { name: 'Bank accounts' }).getByRole('combobox', { name: 'Role' }),
    'Link a bank for the e2e account first (see playwright.capture.config.ts)',
  ).not.toHaveCount(0);
  documentId = await uploadAcmeStub(page);
  await settled(page);
  await shot(page, '03-link-linked');
});

test('06 the Confirm screen, then confirming the stub', async ({ page }) => {
  await openLink(page);
  const proposal = proposalOf(page, documentId);
  await stubRow(page, documentId).getByRole('link').first().click();
  await expect(page).toHaveURL(`/setup/confirm/${documentId}`);
  const fields = await proposal;
  await settled(page);
  await shot(page, '06-confirm-review');

  await confirmAcmeFields(page, fields);
  await page.getByRole('button', { name: /Confirm and continue/ }).click();
  await expect(page).toHaveURL('/setup/spending', { timeout: 30_000 });
});
