import { expect, test, type Locator, type Page } from '@playwright/test';
import { e2eApiUrl, NO_E2E_API } from './support/api';
import { e2eUser, NO_E2E_USER, waitForHydration } from './support/auth';

/*
 * The monthly check-in against the real API with the saved e2e session. The
 * project runs after Decisions (playwright.config.ts), so the user has a
 * confirmed pay stub and saved decisions whose dates (the 401(k) election
 * check, the emergency fund's first contribution and the W-4 hand-in, each
 * due the next payday) fall within 30 days: the month's check-in reports them
 * as upcoming dates (spec 015 rule 7). "Check in now" (`POST /check-ins`,
 * rule 23) creates this month's check-in, or runs it again, through the
 * worker, so nothing waits for the monthly tick. A finding is then marked
 * done, dismissed and undone, and left open as it was. Net worth
 * (`GET /net-worth`, `GET /holdings`) needs no check-in.
 */

test.describe.configure({ mode: 'serial' });
test.skip(!e2eUser(), NO_E2E_USER);
test.skip(!e2eApiUrl(), NO_E2E_API);

/** A check-in run is one worker job; allow for the worker's poll and a cold start. */
const RUN_BUDGET_MS = 60_000;

const list = (page: Page) => page.getByRole('list', { name: 'Check-ins' });
const emptyState = (page: Page) => page.getByText(/^No check-in yet\./);
const checkInNow = (page: Page) => page.getByRole('button', { name: 'Check in now' });

async function openIndex(page: Page) {
  await page.goto('/check-in');
  await waitForHydration(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Monthly check-ins' })).toBeVisible();
  await expect(list(page).or(emptyState(page))).toBeVisible({ timeout: 30_000 });
}

/** Today's month as the list names it ("October 2026"), in UTC like the API's clock. */
const thisMonth = () =>
  new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(),
  );

test('checks in now from the list, then lists this month’s check-in', async ({ page }) => {
  await openIndex(page);
  const netWorth = page.getByRole('region', { name: 'Net worth' });
  await expect(netWorth.getByText(/^As of |^No balances yet\./)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: 'Monthly check-in' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  await checkInNow(page).click();
  const outcome = page
    .getByRole('status')
    .filter({ hasText: /^This month’s check-in is (ready|up to date|already complete)/ });
  await expect(outcome).toBeVisible({ timeout: RUN_BUDGET_MS });
  await expect(checkInNow(page)).not.toHaveAttribute('aria-busy');

  // The list was read again when the job finished: this month is there, newest first.
  const newest = list(page).getByRole('listitem').first();
  await expect(newest.getByRole('link', { name: thisMonth() })).toBeVisible();
  await expect(newest).toContainText(/\d+ findings? · (Open|Completed .+)/);

  // A run that made or refreshed the check-in links to it.
  if (await outcome.getByRole('link', { name: 'Open it' }).isVisible()) {
    await outcome.getByRole('link', { name: 'Open it' }).click();
    await waitForHydration(page);
    await expect(page.getByRole('heading', { level: 1, name: /check-in$/ })).toBeVisible({
      timeout: 30_000,
    });
  }
});

/** The finding's row, found again by its title (its accessible name) after reloads. */
async function firstFinding(page: Page, findings: Locator): Promise<Locator> {
  const first = findings.getByRole('listitem').first();
  await expect(first).toBeVisible();
  const titleId = (await first.getAttribute('aria-labelledby'))!;
  const name = (await page.evaluate((id) => document.getElementById(id)?.textContent, titleId))!;
  return findings.getByRole('listitem', { name, exact: true });
}

/** Today as the screen dates a time ("Oct 30, 2026"), in the browser's zone, which is this one's. */
const today = () =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(
    new Date(),
  );

async function reload(page: Page) {
  await page.reload();
  await waitForHydration(page);
}

test('runs this month’s check-in again, then marks a finding done, dismissed and undone', async ({
  page,
}) => {
  await openIndex(page);
  await list(page).getByRole('link', { name: thisMonth() }).click();
  await waitForHydration(page);
  await expect(page.getByRole('heading', { level: 1, name: /check-in$/ })).toBeVisible({
    timeout: 30_000,
  });
  const findings = page.getByRole('region', { name: 'What changed' });
  await expect(findings).toBeVisible();
  await expect(
    page.getByRole('region', { name: /cash flow against the plan$/ }).getByRole('table'),
  ).toBeVisible();

  // An open check-in for this month can be run again from its own page.
  if (await checkInNow(page).isVisible()) {
    const before = today();
    await checkInNow(page).click();
    await expect(page.getByText('Checked again just now. This page is up to date.')).toBeVisible({
      timeout: RUN_BUDGET_MS,
    });
    // Issue 171: the lead dates the run just made, not the check-in's last change.
    const dates = [...new Set([before, today()])].join('|');
    await expect(
      page.getByText(new RegExp(`^Compared with your plan on (${dates})\\.`)),
    ).toBeVisible();
  }

  const row = await firstFinding(page, findings);
  const button = (name: string) => row.getByRole('button', { name, exact: true });
  // A run against a hosted API may find it handled already: put it back first.
  if (await button('Undo').isVisible()) {
    await button('Undo').click();
    await expect(button('Done')).toBeFocused();
  }
  const badge = findings.getByText(/^\d+ of \d+ handled$/);
  const before = (await badge.textContent())!;

  // Done, kept by the server across a reload, then undone.
  await button('Done').click();
  await expect(button('Undo')).toBeFocused();
  await expect(badge).not.toHaveText(before);
  await reload(page);
  await expect(button('Undo')).toBeVisible({ timeout: 30_000 });
  await expect(row.getByText('Done', { exact: true })).toBeVisible();
  await button('Undo').click();
  await expect(button('Done')).toBeFocused();
  await expect(badge).toHaveText(before);

  // Dismissed, kept across a reload, then undone and left open as it was.
  await button('Dismiss').click();
  await expect(button('Undo')).toBeFocused();
  await reload(page);
  await expect(button('Undo')).toBeVisible({ timeout: 30_000 });
  await expect(row.getByText('Dismissed', { exact: true })).toBeVisible();
  await button('Undo').click();
  await expect(button('Done')).toBeFocused();
  await reload(page);
  await expect(button('Done')).toBeVisible({ timeout: 30_000 });
  await expect(badge).toHaveText(before);
});

test('links a finding to the decision step it affects', async ({ page }) => {
  await openIndex(page);
  await list(page).getByRole('link', { name: thisMonth() }).click();
  await waitForHydration(page);
  const findings = page.getByRole('region', { name: 'What changed' });
  await expect(findings).toBeVisible({ timeout: 30_000 });
  // Spec 018 rule 4: a decision's finding opens that calculator's own step.
  const affects = findings.getByRole('link', { name: /^Affects: (?!Spending map$)/ });
  const count = await affects.count();
  for (let index = 0; index < count; index += 1) {
    await expect(affects.nth(index)).toHaveAttribute(
      'href',
      /^\/setup\/decisions\/(emergency-fund|401k|health-plan|w4)$/,
    );
  }
  // Issue 170: the W-4 hand-in reminder Decisions saved names the W-4 step too.
  const w4 = findings.getByRole('listitem', { name: 'Give your employer your updated Form W-4' });
  await expect(w4.getByRole('link', { name: /^Affects: / })).toHaveAttribute(
    'href',
    '/setup/decisions/w4',
  );
  test.skip(count === 0, 'No finding this month affects a decision');
  const href = (await affects.first().getAttribute('href'))!;
  await affects.first().click();
  await expect(page).toHaveURL(href);
  await expect(page.getByText(/^Decision \d of 4$/)).toBeVisible({ timeout: 30_000 });
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
