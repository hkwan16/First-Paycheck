import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';
import { STORAGE_STATE } from './e2e/support/auth';

/*
 * Captures the alpha document's screenshots from a deployed web app (no dev
 * server): the real sign-in, the real API and worker behind it. It signs in
 * as the e2e user, makes the data the screens need through the product (a pay
 * stub, the decisions, a check-in) and writes the PNGs to E2E_CAPTURE_DIR.
 *
 *   E2E_WEB_URL=https://<web host> E2E_API_URL=https://<api host> \
 *   E2E_CAPTURE_DIR=../docs/alpha/screenshots \
 *     pnpm exec playwright test -c playwright.capture.config.ts
 *
 * The bank is linked beforehand through the API's sandbox route (Plaid Link's
 * iframe is not driven by automation), so there is no shot of the sync itself.
 */
if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const WEB_URL = process.env.E2E_WEB_URL?.trim();
if (!WEB_URL) throw new Error('Set E2E_WEB_URL to the deployed web app to capture from.');

const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 820 } };
const signedIn = { ...desktop, storageState: STORAGE_STATE };

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 120_000,
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    colorScheme: 'light',
    reducedMotion: 'no-preference',
  },
  projects: [
    { name: 'setup', testMatch: 'auth.setup.ts', use: desktop },
    // Sign-in, the linked accounts, the uploaded stub and its Confirm screen.
    {
      name: 'capture-setup',
      testMatch: 'capture-setup.spec.ts',
      dependencies: ['setup'],
      use: signedIn,
    },
    // The product's own real-API specs make the decisions, the plan and the check-in.
    {
      name: 'authenticated-decisions',
      testMatch: 'decisions.spec.ts',
      dependencies: ['capture-setup'],
      use: signedIn,
    },
    {
      name: 'authenticated-plan',
      testMatch: 'plan.spec.ts',
      dependencies: ['authenticated-decisions'],
      use: signedIn,
    },
    {
      name: 'authenticated-check-in',
      testMatch: 'check-in.spec.ts',
      dependencies: ['authenticated-decisions'],
      use: signedIn,
    },
    // Spending, Decisions, Why, Plan and the check-in screens over that data.
    {
      name: 'capture-screens',
      testMatch: 'capture-screens.spec.ts',
      dependencies: ['authenticated-plan', 'authenticated-check-in'],
      use: signedIn,
    },
  ],
});
