import { expect, test } from '@playwright/test';
import { e2eApiUrl, NO_E2E_API } from './support/api';
import { e2eUser, NO_E2E_USER, waitForHydration } from './support/auth';

/*
 * Addresses that name nothing, with the saved session (issue 237): an id that
 * is not an id reads as not found, the same as an id that names no row, and
 * an unknown page is the app's own not-found page with a way back.
 */

test.skip(!e2eUser(), NO_E2E_USER);

test.describe('an id that is not an id', () => {
  test.skip(!e2eApiUrl(), NO_E2E_API);

  test('a Why page is "Decision not found", with the way to the saved decisions', async ({
    page,
  }) => {
    await page.goto('/why/not-a-uuid');
    await waitForHydration(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Decision not found' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/Reload the page/)).toHaveCount(0);
    await page.getByRole('link', { name: 'See your saved decisions' }).click();
    await expect(page).toHaveURL('/why');
  });

  test('a check-in is "Check-in not found"', async ({ page }) => {
    await page.goto('/check-in/not-a-uuid');
    await waitForHydration(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Check-in not found' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('link', { name: 'See all check-ins' })).toBeVisible();
  });

  test('a document to confirm says it was not found, as an unknown id does', async ({ page }) => {
    for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      await page.goto(`/setup/confirm/${id}`);
      await waitForHydration(page);
      // The API's sentence for a well-formed unknown id names the document; for
      // a malformed one it cannot know the route's noun. Neither asks for a reload.
      const notice = page.getByRole('main').getByRole('alert');
      await expect(notice, id).toContainText(/not found/i, { timeout: 30_000 });
      await expect(notice, id).not.toContainText('connection');
    }
  });
});

test('an unknown page is the app’s not-found page with a way back', async ({ page }) => {
  const response = await page.goto('/no-such-page');
  expect(response?.status()).toBe(404);
  await waitForHydration(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('banner').getByText('First Paycheck')).toBeVisible();
  await page.getByRole('link', { name: 'Go to First Paycheck' }).click();
  await expect(page).toHaveURL('/setup/link');
});
