import { expect, test } from '@playwright/test';
import {
  e2eUser,
  NO_E2E_USER,
  NO_SUPABASE,
  SIGNED_OUT,
  signIn,
  submitSignIn,
  supabaseConfigured,
  waitForHydration,
} from './support/auth';

/*
 * Auth against the Supabase project in NEXT_PUBLIC_SUPABASE_URL. The signed-out
 * tests need only that project; the rest need the e2e user. Tests that sign out
 * sign in through the form first, so they end their own session and never the
 * one auth.setup.ts saved for the other tests.
 */

test.describe('signed out', () => {
  test.use({ storageState: SIGNED_OUT });
  test.skip(!supabaseConfigured(), NO_SUPABASE);

  test('a visit to a setup screen goes to sign in and remembers the path', async ({ page }) => {
    await page.goto('/setup/link');
    await expect(page).toHaveURL('/sign-in?next=/setup/link');
    await expect(page.getByRole('form', { name: 'Sign in' })).toBeVisible();
  });

  test('a wrong password shows the warning notice and stays on sign in', async ({ page }) => {
    await page.goto('/sign-in');
    // No email is sent for a password attempt, so a synthetic address is safe here.
    await submitSignIn(page, e2eUser()?.email ?? 'nobody@example.com', 'not the right password');
    // Scoped to the form: Next's route announcer is also role="alert".
    const form = page.getByRole('form', { name: 'Sign in' });
    await expect(form.getByRole('alert')).toHaveText(
      'That email and password do not match. Check them and try again, or email yourself a sign-in link.',
    );
    await expect(page).toHaveURL('/sign-in');
  });
});

test.describe('signing in and out', () => {
  test.use({ storageState: SIGNED_OUT });
  test.skip(!e2eUser(), NO_E2E_USER);

  test('signing in lands on the first setup step with the user chip', async ({ page }) => {
    const user = e2eUser()!;
    await signIn(page, user);
    await expect(page.getByRole('button', { name: user.email })).toBeVisible();
    await expect(page.getByText('Sample data')).toBeVisible();
  });

  test('signing in returns to the page that asked for it', async ({ page }) => {
    const user = e2eUser()!;
    await page.goto('/plan');
    await expect(page).toHaveURL('/sign-in?next=/plan');
    await submitSignIn(page, user.email, user.password);
    await expect(page).toHaveURL('/plan');
  });

  test('signing out returns to sign in and ends the session', async ({ page }) => {
    const user = e2eUser()!;
    await signIn(page, user);
    await waitForHydration(page);
    await page.getByRole('button', { name: user.email }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL('/sign-in');

    await page.goto('/setup/link');
    await expect(page).toHaveURL('/sign-in?next=/setup/link');
  });
});

test.describe('with the saved session', () => {
  test.skip(!e2eUser(), NO_E2E_USER);

  test('the root goes straight to the first setup step', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL('/setup/link');
    await expect(page.getByRole('button', { name: e2eUser()!.email })).toBeVisible();
  });
});
