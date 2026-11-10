import { expect, test } from '@playwright/test';
import {
  e2eApiUrl,
  linkSandboxBank,
  NO_E2E_API,
  NO_PLAID_SANDBOX,
  openLink,
  plaidSandboxAvailable,
  unlinkAll,
} from './support/api';
import { e2eUser, NO_E2E_USER } from './support/auth';

/*
 * The Link screen against the real API with the saved e2e session: link
 * Plaid's sandbox bank, follow its sync, set roles, and the unlink
 * confirmation. Serial: each test builds on the linked state of the one
 * before, and spending.spec.ts (a dependent project) reads it afterwards.
 */

test.describe.configure({ mode: 'serial' });
test.skip(!e2eUser(), NO_E2E_USER);
test.skip(!e2eApiUrl(), NO_E2E_API);
test.skip(!plaidSandboxAvailable(), NO_PLAID_SANDBOX);

test('links the sandbox bank and follows the sync until its accounts appear', async ({ page }) => {
  await openLink(page);
  await unlinkAll(page);
  await expect(page.getByText(/No accounts linked yet/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Continue to spending/ })).toBeDisabled();

  await linkSandboxBank(page);
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Continue to spending/ })).toBeVisible();
});

test('a role change is saved', async ({ page }) => {
  await openLink(page);
  const checking = page.getByRole('group', { name: 'Plaid Checking' });
  const saving = page.getByRole('group', { name: 'Plaid Saving' });
  // Each select is named for its account (issue 242).
  const checkingRole = checking.getByRole('combobox', { name: /^Role for Plaid Checking/ });
  const savingRole = saving.getByRole('combobox', { name: /^Role for Plaid Saving/ });
  await checkingRole.selectOption('Spending');
  await savingRole.selectOption('Emergency fund');
  await expect(savingRole).not.toHaveAttribute('aria-busy', 'true');

  await page.reload();
  await openLink(page);
  await expect(checkingRole).toHaveValue('spending');
  await expect(savingRole).toHaveValue('emergency_fund');
});

test('each account offers only the roles its kind takes, and a role can be cleared (issue 241)', async ({
  page,
}) => {
  await openLink(page);
  const checkingRole = page
    .getByRole('group', { name: 'Plaid Checking' })
    .getByRole('combobox', { name: /^Role for Plaid Checking/ });
  const savingRole = page
    .getByRole('group', { name: 'Plaid Saving' })
    .getByRole('combobox', { name: /^Role for Plaid Saving/ });
  await expect(checkingRole.locator('option')).toHaveText([
    'No role',
    'Spending',
    'Emergency fund',
    'Not used',
  ]);
  // A savings account is never the spending account (spec 002 rule 31a).
  await expect(savingRole.locator('option')).toHaveText(['No role', 'Emergency fund', 'Not used']);

  await checkingRole.selectOption('No role');
  await expect(checkingRole).not.toHaveAttribute('aria-busy', 'true');
  await page.reload();
  await openLink(page);
  await expect(checkingRole).toHaveValue('');

  // Back to spending, which the Spending project reads next.
  await checkingRole.selectOption('Spending');
  await expect(checkingRole).not.toHaveAttribute('aria-busy', 'true');
  await page.reload();
  await openLink(page);
  await expect(checkingRole).toHaveValue('spending');
});

test('Sync now says how it went beside the bank it synced (issue 208)', async ({ page }) => {
  test.setTimeout(360_000);
  await openLink(page);
  const sync = page.getByRole('button', { name: /^Sync now for / }).first();
  const name = ((await sync.getAttribute('aria-label')) ?? '').replace(/^Sync now for /, '');
  await sync.click();
  // The outcome shows in the bank's own group, under the button pressed, not
  // at the bottom of the card.
  const bank = page.getByRole('region', { name, exact: true });
  await expect(bank.getByRole('status').filter({ hasText: `Synced ${name}.` })).toBeVisible({
    timeout: 300_000,
  });
});

test('unlinking asks first, and keeping the bank changes nothing', async ({ page }) => {
  await openLink(page);
  const unlink = page.getByRole('button', { name: /^Unlink / }).first();
  const label = (await unlink.getAttribute('aria-label')) ?? '';
  const name = label.replace(/^Unlink /, '');
  await unlink.click();

  const confirm = page.getByRole('group', { name: `Unlink ${name}?` });
  await expect(confirm).toContainText('will be deleted');
  await expect(confirm.getByRole('button', { name: `Keep ${name}` })).toBeFocused();
  await confirm.getByRole('button', { name: `Keep ${name}` }).click();

  await expect(confirm).toHaveCount(0);
  await expect(page.getByRole('button', { name: label, exact: true })).toBeFocused();
  await expect(page.getByRole('group', { name: 'Plaid Checking' })).toBeVisible();
});
