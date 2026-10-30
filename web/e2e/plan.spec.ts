import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { e2eApiUrl, NO_E2E_API } from './support/api';
import { e2eUser, NO_E2E_USER, waitForHydration } from './support/auth';

/*
 * The Plan screen against the real API with the saved e2e session, after
 * decisions.spec.ts has saved the four decisions: the plan reads them back
 * (every figure is the API's), the calendar file downloads and is iCalendar,
 * and the PDF export runs as a worker job and downloads as a PDF. Nothing is
 * changed: an export is a new row the scheduler deletes after 7 days.
 */

test.describe.configure({ mode: 'serial' });
test.skip(!e2eUser(), NO_E2E_USER);
test.skip(!e2eApiUrl(), NO_E2E_API);

/** WeasyPrint in the worker; the first render loads fonts. */
const EXPORT_BUDGET_MS = 90_000;

async function openPlan(page: Page) {
  await page.goto('/plan');
  await waitForHydration(page);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Your plan, on one page' }),
  ).toBeVisible();
  await expect(page.getByText(/^\d of \d decisions saved$/)).toBeVisible({ timeout: 30_000 });
}

test('reads the saved decisions back with their figures and the next 90 days', async ({ page }) => {
  await openPlan(page);
  await expect(page.getByRole('link', { name: 'Plan and calendar' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const decisions = page.getByRole('list', { name: 'Saved decisions' });
  // decisions.spec.ts saved all four.
  await expect(page.getByText('4 of 4 decisions saved')).toBeVisible();
  // Chromium reads the hidden ", done" as its own word.
  await expect(page.getByRole('link', { name: /^Plan and calendar\s*, done$/ })).toBeVisible({
    timeout: 30_000,
  });
  await expect(decisions.getByRole('heading', { level: 2 })).toHaveText([
    'Emergency fund',
    '401(k) match',
    'Health plan',
    'W-4, federal only',
  ]);
  const k401 = page.getByRole('region', { name: '401(k) match' });
  await expect(k401.getByText('Your contribution')).toBeVisible();
  await expect(k401.getByText(/^v\d+ · Saved /)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Your paycheck' })).toContainText('Take-home pay');
  await expect(page.getByRole('region', { name: 'Next 90 days' })).toContainText(/Through /);
  // Spec 018: each date's badge opens its decision's step; Back goes to the last step.
  const badges = page.getByRole('region', { name: 'Next 90 days' }).getByRole('link');
  for (let index = 0; index < (await badges.count()); index += 1) {
    await expect(badges.nth(index)).toHaveAttribute(
      'href',
      /^\/setup\/decisions\/(emergency-fund|401k|health-plan|w4)$/,
    );
  }
  await expect(page.getByRole('link', { name: 'Back to decisions' })).toHaveAttribute(
    'href',
    '/setup/decisions/w4',
  );
});

test('downloads the calendar file', async ({ page }) => {
  await openPlan(page);
  const exportCard = page.getByRole('region', { name: 'Export' });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    exportCard.getByRole('button', { name: 'Add to calendar (.ics)' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('first-paycheck-calendar.ics');
  const text = await readFile((await download.path())!, 'utf8');
  expect(text.split('\r\n')[0]).toBe('BEGIN:VCALENDAR');
  expect(text).toContain('BEGIN:VEVENT');
  await expect(exportCard.getByRole('status')).toHaveText(
    /^Downloaded first-paycheck-calendar\.ics\./,
  );
});

test('exports the plan as a PDF through the worker and downloads it', async ({ page }) => {
  test.setTimeout(EXPORT_BUDGET_MS + 30_000);
  await openPlan(page);
  const exportCard = page.getByRole('region', { name: 'Export' });
  const pdfResponse = page.waitForResponse(
    (response) =>
      /\/plan\/export\/[0-9a-f-]+$/.test(new URL(response.url()).pathname) &&
      response.request().method() === 'GET',
    { timeout: EXPORT_BUDGET_MS },
  );
  const downloaded = page.waitForEvent('download', { timeout: EXPORT_BUDGET_MS });
  await exportCard.getByRole('button', { name: 'Download PDF' }).click();

  const response = await pdfResponse;
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('application/pdf');
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/^first-paycheck-plan(-\d{4}-\d{2}-\d{2})?\.pdf$/);
  const bytes = await readFile((await download.path())!);
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  await expect(exportCard.getByRole('status')).toHaveText(/^Downloaded first-paycheck-plan/);
});
