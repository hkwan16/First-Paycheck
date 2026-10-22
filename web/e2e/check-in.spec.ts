import { expect, test, type Page } from '@playwright/test';
import { e2eApiUrl, NO_E2E_API } from './support/api';
import { e2eUser, NO_E2E_USER, waitForHydration } from './support/auth';

/*
 * The monthly check-in against the real API with the saved e2e session.
 * Nothing here is seeded: the API has no route that creates a check-in
 * (`POST /check-ins` is out of scope in spec 015); the worker's monthly
 * `schedule.tick` makes one per user. So the list is either empty, and its
 * empty state is checked, or it holds the e2e user's check-ins, and the
 * newest is opened and a finding marked done and undone, leaving it as it
 * was. Net worth (`GET /net-worth`, `GET /holdings`) needs no check-in.
 */

test.describe.configure({ mode: 'serial' });
test.skip(!e2eUser(), NO_E2E_USER);
test.skip(!e2eApiUrl(), NO_E2E_API);

const list = (page: Page) => page.getByRole('list', { name: 'Check-ins' });
const emptyState = (page: Page) => page.getByText(/^No check-in yet\./);

async function openIndex(page: Page) {
  await page.goto('/check-in');
  await waitForHydration(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Monthly check-ins' })).toBeVisible();
  await expect(list(page).or(emptyState(page))).toBeVisible({ timeout: 30_000 });
}

test('lists the check-ins, or says when the first one comes, with net worth either way', async ({
  page,
}) => {
  await openIndex(page);
  const netWorth = page.getByRole('region', { name: 'Net worth' });
  await expect(netWorth.getByText(/^As of |^No balances yet\./)).toBeVisible({ timeout: 30_000 });

  const nav = page.getByRole('link', { name: 'Monthly check-in' });
  await expect(nav).toHaveAttribute('aria-current', 'page');
  if (await emptyState(page).isVisible()) {
    test.info().annotations.push({ type: 'note', description: 'The e2e user has no check-in yet' });
    await expect(nav).toHaveAttribute('href', '/check-in');
    return;
  }
  const items = list(page).getByRole('listitem');
  expect(await items.count()).toBeGreaterThan(0);
  await expect(items.first()).toContainText(/\d+ findings? · (Open|Completed .+)/);
});

test('opens the newest check-in and marks a finding done, then undoes it', async ({ page }) => {
  await openIndex(page);
  test.skip(await emptyState(page).isVisible(), 'The e2e user has no check-in to open yet');

  await list(page).getByRole('link').first().click();
  await waitForHydration(page);
  await expect(page.getByRole('heading', { level: 1, name: /check-in$/ })).toBeVisible({
    timeout: 30_000,
  });
  const findings = page.getByRole('region', { name: 'What changed' });
  await expect(findings).toBeVisible();
  await expect(
    page.getByRole('region', { name: /cash flow against the plan$/ }).getByRole('table'),
  ).toBeVisible();

  const done = findings.getByRole('button', { name: 'Done' });
  test.skip((await done.count()) === 0, 'Every finding is handled, or there are none');
  const badge = findings.getByText(/^\d+ of \d+ handled$/);
  const before = await badge.textContent();
  // The first open finding, found again by its title (its accessible name) after reloads.
  const titleId = (await findings
    .getByRole('listitem')
    .filter({ has: done.first() })
    .first()
    .getAttribute('aria-labelledby'))!;
  const name = (await page.evaluate((id) => document.getElementById(id)?.textContent, titleId))!;
  const sameRow = findings.getByRole('listitem', { name, exact: true });

  await done.first().click();
  const undo = sameRow.getByRole('button', { name: 'Undo' });
  await expect(undo).toBeFocused();
  await expect(badge).not.toHaveText(before!);

  // The server kept it: a reload shows it done.
  await page.reload();
  await waitForHydration(page);
  await expect(sameRow.getByRole('button', { name: 'Undo' })).toBeVisible({ timeout: 30_000 });

  await sameRow.getByRole('button', { name: 'Undo' }).click();
  await expect(sameRow.getByRole('button', { name: 'Done' })).toBeFocused();
  await expect(badge).toHaveText(before!);
  await page.reload();
  await waitForHydration(page);
  await expect(sameRow.getByRole('button', { name: 'Done' })).toBeVisible({ timeout: 30_000 });
});

test('a check-in that is not the user’s is not found', async ({ page }) => {
  await page.goto('/check-in/00000000-0000-4000-8000-000000000000');
  await waitForHydration(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Check-in not found' })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('link', { name: 'See all check-ins' }).click();
  await expect(page).toHaveURL(/\/check-in$/);
});
