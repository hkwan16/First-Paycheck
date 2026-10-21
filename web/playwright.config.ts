import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';
import { STORAGE_STATE } from './e2e/support/auth';

// Local runs read web/.env.local like `next dev` does (Supabase project, e2e
// credentials); variables already in the environment win. CI has no such
// file, so the auth tests skip there unless the variables are set.
if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const PORT = Number(process.env.E2E_PORT ?? 3100);
const CI = Boolean(process.env.CI);

const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 820 } };

/**
 * Smoke and visual checks at the two widths the mockup targets, plus the auth
 * flows against the configured Supabase project. The server is `next dev`
 * because /dev/kit is a 404 in production builds; the e2e flag hides dev-only
 * overlays from the screenshots.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: CI,
  // Flaky tests get fixed, not retried.
  retries: 0,
  workers: CI ? 2 : undefined,
  reporter: CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  snapshotPathTemplate:
    '{testDir}/__screenshots__/{testFileName}/{arg}-{projectName}-{platform}{ext}',
  expect: {
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', scale: 'css' },
  },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    colorScheme: 'light',
    reducedMotion: 'no-preference',
  },
  projects: [
    { name: 'desktop', testMatch: 'smoke.spec.ts', use: desktop },
    {
      name: 'phone',
      testMatch: 'smoke.spec.ts',
      use: {
        ...devices['iPhone 14'],
        // CI installs Chromium only; the device still sets touch, mobile UA and DPR.
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
      },
    },
    // Signs in once and saves the session; skips without E2E_USER_EMAIL/PASSWORD.
    { name: 'setup', testMatch: 'auth.setup.ts', use: desktop },
    {
      name: 'authenticated',
      testMatch: 'auth.spec.ts',
      dependencies: ['setup'],
      use: { ...desktop, storageState: STORAGE_STATE },
    },
    // The same saved session against the real API (E2E_API_URL; skipped without it).
    // Two projects in order, because both change the e2e user's linked data:
    // Spending reads what Link linked.
    {
      name: 'authenticated-link',
      testMatch: 'link.spec.ts',
      dependencies: ['setup'],
      use: { ...desktop, storageState: STORAGE_STATE },
    },
    // Uploads and confirms a pay stub; documents are apart from linked data, so
    // it needs only the saved session.
    {
      name: 'authenticated-confirm',
      testMatch: 'confirm.spec.ts',
      dependencies: ['setup'],
      use: { ...desktop, storageState: STORAGE_STATE },
    },
    // Saves 401(k) decisions over the pay stub Confirm confirmed.
    {
      name: 'authenticated-decisions',
      testMatch: 'decisions.spec.ts',
      dependencies: ['authenticated-confirm'],
      use: { ...desktop, storageState: STORAGE_STATE },
    },
    {
      name: 'authenticated-spending',
      testMatch: 'spending.spec.ts',
      dependencies: ['authenticated-link'],
      use: { ...desktop, storageState: STORAGE_STATE },
    },
  ],
  webServer: {
    command: `next dev --port ${PORT}`,
    url: `http://localhost:${PORT}/sign-in`,
    reuseExistingServer: !CI,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      NEXT_PUBLIC_FEATURES: 'e2e',
      // The e2e account's header shows the "Sample data" chip.
      NEXT_PUBLIC_E2E_USER_EMAIL:
        process.env.NEXT_PUBLIC_E2E_USER_EMAIL ?? process.env.E2E_USER_EMAIL ?? '',
      NEXT_TELEMETRY_DISABLED: '1',
      // Link and Spending e2e tests run against this API (e2e/support/api.ts).
      ...(process.env.E2E_API_URL ? { NEXT_PUBLIC_API_URL: process.env.E2E_API_URL } : {}),
    },
  },
});
