import { expect, test } from '@playwright/test';
import { e2eApiUrl, linkSandboxBank, NO_E2E_API, openLink, unlinkAll } from './support/api';
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
  await checking.getByRole('combobox', { name: 'Role' }).selectOption('Spending');
  await saving.getByRole('combobox', { name: 'Role' }).selectOption('Emergency fund');
  await expect(saving.getByRole('combobox', { name: 'Role' })).not.toHaveAttribute(
    'aria-busy',
    'true',
  );

  await page.reload();
  await openLink(page);
  await expect(checking.getByRole('combobox', { name: 'Role' })).toHaveValue('spending');
  await expect(saving.getByRole('combobox', { name: 'Role' })).toHaveValue('emergency_fund');
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
