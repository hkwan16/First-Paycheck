import { expect, test, type Page } from '@playwright/test';
import { NO_AUTH_FAULTS, sessionUser, setAuthFaults } from './support/auth-faults';
import { SIGNED_OUT, signIn, waitForHydration } from './support/auth';

/*
 * A session read that never resolves (issue 225). Seen once in production: a
 * page sat on loading skeletons for over a minute with no request to the API,
 * and a reload fixed it. The cause there was not captured. This reproduces
 * one way to get exactly that: the browser's clock is two hours on (its
 * access token has expired; the server's clock is not, so the page itself
 * renders), and Supabase never answers the token refresh. supabase-js's
 * session read waits on that refresh with no timeout, and every API request
 * waits on the session read before it is sent.
 */
test.use({ storageState: SIGNED_OUT });
test.describe.configure({ mode: 'serial' });
test.skip(!sessionUser(), NO_AUTH_FAULTS);

const IDLE = '02:00:00';

/** Requests to the API from now on. */
function apiRequests(page: Page) {
  const apiOrigin = new URL(process.env.E2E_API_URL ?? 'http://api.invalid').origin;
  const seen: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).origin === apiOrigin) seen.push(request.url());
  });
  return seen;
}

test('a session read that never resolves ends in a notice with a way out, not a skeleton', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const user = sessionUser()!;
  await page.clock.install();
  await signIn(page, user);

  await setAuthFaults(user, { refresh: 'hang' });
  try {
    await page.clock.fastForward(IDLE);
    const requests = apiRequests(page);
    await page.goto('/plan');
    await waitForHydration(page);

    const notice = page.getByRole('alert', { name: 'We could not check that you are signed in.' });
    await expect(notice).toBeVisible({ timeout: 30_000 });
    // Nothing was sent with a session nobody could read.
    expect(requests).toEqual([]);
    await expect(notice.getByRole('button', { name: 'Reload the page' })).toBeVisible();
    // The plan itself stops loading and says why.
    await expect(page.getByLabel('Loading your plan')).toHaveCount(0);
    await expect(
      page
        .getByRole('main')
        .getByRole('alert')
        .filter({ hasText: 'Reload the page, or sign in again.' }),
    ).toBeVisible();

    // Signing in again starts from a clean session.
    await notice.getByRole('button', { name: 'Sign in again' }).click();
    await expect(page).toHaveURL('/sign-in');
  } finally {
    await setAuthFaults(user, { refresh: 'ok' });
  }
});
