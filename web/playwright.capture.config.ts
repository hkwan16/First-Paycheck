import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';
import { STORAGE_STATE } from './e2e/support/auth';

/*
 * Captures the alpha document's screenshots and its two-minute demo recording
 * from a deployed web app (no dev server): the real sign-in, the real API and
 * worker behind it. It signs in as the e2e user, makes the data the screens
 * need through the product (a pay stub, the decisions, a check-in), writes
 * the PNGs to E2E_CAPTURE_DIR and the recording to docs/alpha/alpha-demo.mp4
 * (E2E_DEMO_MP4 overrides it). Run from web/. Credentials come from
 * web/.env.local (E2E_USER_EMAIL, E2E_USER_PASSWORD and the Supabase project);
 * the converter is Homebrew's ffmpeg (FFMPEG overrides it).
 *
 * Everything, signing in through the form first (auth.setup.ts):
 *
 *   E2E_WEB_URL=https://first-paycheck-silk.vercel.app \
 *   E2E_API_URL=https://first-paycheck-api.onrender.com \
 *   E2E_CAPTURE_DIR=../docs/alpha/screenshots \
 *     pnpm exec playwright test -c playwright.capture.config.ts
 *
 * Only the recording, over the data earlier runs left, from the session saved
 * at e2e/.auth/user.json (no password typed; --no-deps skips auth.setup.ts and
 * the projects that make data):
 *
 *   E2E_WEB_URL=https://first-paycheck-silk.vercel.app \
 *   E2E_CAPTURE_DIR=../docs/alpha/screenshots \
 *     pnpm exec playwright test -c playwright.capture.config.ts --project=capture-demo --no-deps
 *
 * The screenshots alone, from the saved session, add the projects in their
 * order: --project=capture-setup --project=authenticated-decisions
 * --project=authenticated-plan --project=authenticated-check-in
 * --project=capture-screens --no-deps (these need E2E_API_URL too).
 *
 * A saved session lasts as long as Supabase keeps its refresh token (the app
 * refreshes the access token itself). When it has expired, the demo fails at
 * once and says so; save a new one by signing in once through the form, then
 * run the command above again:
 *
 *   E2E_WEB_URL=https://first-paycheck-silk.vercel.app \
 *     pnpm exec playwright test -c playwright.capture.config.ts --project=setup
 *
 * The bank is linked beforehand through the API's sandbox route (Plaid Link's
 * iframe is not driven by automation), so there is no shot of the sync itself.
 * The recording uploads and confirms one Acme stub, saves one 401(k) version
 * and writes its explanation; a rerun over that state, or over any earlier
 * run's, works the same, except that each confirmed copy of the stub counts in
 * October's cash flow again until that bug is fixed (docs/backlog.yaml).
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
    // Issue 172's test checks a window height against the step's loading layout,
    // a regression check that says nothing about the data the capture needs.
    {
      name: 'authenticated-decisions',
      testMatch: 'decisions.spec.ts',
      grepInvert: /issue 172/,
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
    // The demo recording, last, over everything the projects above made. It
    // opens its own 1280x720 windows from the saved session.
    {
      name: 'capture-demo',
      testMatch: 'capture-demo.spec.ts',
      dependencies: ['capture-screens'],
      use: desktop,
    },
  ],
});
