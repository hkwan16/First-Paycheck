import { expect, test, type Page } from '@playwright/test';
import { NO_AUTH_FAULTS, sessionUser, setAuthFaults } from './support/auth-faults';
import { SIGNED_OUT, signIn, waitForHydration, type E2EUser } from './support/auth';

/*
 * Signing out, as the session user (issue 224). Back after Sign out must not
 * show the signed-in page, and a sign-out Supabase fails must still sign this
 * browser out.
 *
 * Playwright launches Chromium with the back/forward cache off; people's
 * browsers have it on, so this file turns it back on, with the settings under
 * which Chrome keeps a `Cache-Control: no-store` page whose non-HttpOnly
 * cookies changed (Supabase's are not HttpOnly) and swaps browsing instances
 * on a same-site navigation, as desktop Chrome does. `next dev`'s live-reload
 * socket keeps every page out of that cache, so only a production server
 * (`next start`) exercises the restore; the test notes which it got.
 */
test.use({
  storageState: SIGNED_OUT,
  channel: 'chromium',
  launchOptions: {
    ignoreDefaultArgs: ['--disable-back-forward-cache'],
    args: [
      '--enable-features=' +
        [
          'CacheControlNoStoreEnterBackForwardCache:level/restore-unless-http-only-cookie-change',
          'ProactivelySwapBrowsingInstance:level/SameSite',
        ].join(','),
    ],
  },
});
test.describe.configure({ mode: 'serial' });
test.skip(!sessionUser(), NO_AUTH_FAULTS);

async function signOut(page: Page, user: E2EUser) {
  await waitForHydration(page);
  await page.getByRole('button', { name: user.email }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL('/sign-in');
}

/** Record whether Back came from the back/forward cache, as a test annotation. */
async function noteBackForwardCache(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.enable');
  const notUsed: string[] = [];
  cdp.on('Page.backForwardCacheNotUsed', (event) => {
    notUsed.push(...event.notRestoredExplanations.map((reason) => reason.reason));
  });
  return () =>
    test.info().annotations.push({
      type: 'back/forward cache',
      description: notUsed.length ? `not used: ${notUsed.join(', ')}` : 'restored from it',
    });
}

test('Back after signing out shows sign in, not the signed-in page', async ({ page }) => {
  const user = sessionUser()!;
  await signIn(page, user);
  // A page loaded in full, so Back has a whole document to bring back.
  await page.goto('/plan');
  await waitForHydration(page);
  await signOut(page, user);
  await waitForHydration(page);

  const note = await noteBackForwardCache(page);
  // A restored page fires no load event, so wait only for the history step.
  await page.goBack({ waitUntil: 'commit' });
  await expect(page).toHaveURL('/sign-in?next=/plan');
  note();
  await expect(page.getByRole('form', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByText(user.email)).toHaveCount(0);
});

test('a signed-in page is never stored by the browser', async ({ page }) => {
  const user = sessionUser()!;
  await signIn(page, user);
  const response = await page.request.get('/setup/link', { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toContain('no-store');
});

test('a sign-out Supabase answers with 503 still signs this browser out', async ({ page }) => {
  const user = sessionUser()!;
  await signIn(page, user);
  await setAuthFaults(user, { logout: 'unavailable' });
  try {
    await signOut(page, user);
  } finally {
    await setAuthFaults(user, { logout: 'ok' });
  }
  await page.goto('/setup/link');
  await expect(page).toHaveURL('/sign-in?next=/setup/link');
});
