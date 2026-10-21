import { test as setup } from '@playwright/test';
import { e2eUser, NO_E2E_USER, signIn, STORAGE_STATE } from './support/auth';

/** Signs in once through the real form and saves the session for the `authenticated` project. */
setup('sign in as the e2e user', async ({ page }) => {
  const user = e2eUser();
  setup.skip(!user, NO_E2E_USER);
  await signIn(page, user!);
  await page.context().storageState({ path: STORAGE_STATE });
});
