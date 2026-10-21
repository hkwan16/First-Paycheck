import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/** When the sample data was synced plus four minutes ("Synced 4 minutes ago"). */
const SAMPLE_NOW = new Date('2026-10-17T16:00:00Z');

interface Screen {
  path: string;
  name: string;
  heading: string | RegExp;
  /** Rendered from src/test/fixtures/sample.ts: freeze the clock, keep Plaid off the network. */
  sample?: boolean;
}

const SCREENS: readonly Screen[] = [
  { path: '/sign-in', name: 'sign-in', heading: /Your first month's money decisions/ },
  { path: '/dev/kit', name: 'kit', heading: 'Component kit' },
  {
    path: '/dev/screens/link',
    name: 'link',
    heading: 'Link your accounts and add your documents',
    sample: true,
  },
  {
    path: '/dev/screens/confirm',
    name: 'confirm',
    heading: 'Check what we read from your pay stub',
    sample: true,
  },
  {
    path: '/dev/screens/confirm/manual',
    name: 'confirm-manual',
    heading: 'Enter what your pay stub says',
    sample: true,
  },
  {
    path: '/dev/screens/spending',
    name: 'spending',
    heading: 'Where your money went',
    sample: true,
  },
];

/** Collect console errors and uncaught exceptions for the life of the page. */
function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function open(page: Page, { path, heading, sample }: Screen) {
  if (sample) {
    await page.clock.setFixedTime(SAMPLE_NOW);
    // Plaid Link's script loads on mount unless Plaid is already on the page
    // (lib/plaid-script.ts); these pages never open Link. A stand-in keeps it
    // off the network without page.route, which turns off the browser cache:
    // Chromium then sends `Cache-Control: no-cache`, and `next dev` logs that
    // it rendered the route with its server caches disabled.
    await page.addInitScript(() => {
      Object.assign(window, { Plaid: { create: () => undefined } });
    });
  }
  await page.goto(path);
  // Interacting or screenshotting before hydration races React (Playwright's
  // caret hiding, for one, would cause a hydration mismatch).
  await page.locator('html[data-hydrated="true"]').waitFor();
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

test('the root sends visitors to sign in', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);
});

for (const screen of SCREENS) {
  test.describe(screen.path, () => {
    test('renders cleanly with no serious or critical axe violations', async ({ page }) => {
      const errors = watchErrors(page);
      await open(page, screen);

      const { violations } = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
        .analyze();
      const blocking = violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);

      expect(blocking).toEqual([]);
      expect(errors).toEqual([]);
    });

    test('matches the visual baseline', async ({ page }) => {
      await open(page, screen);
      await expect(page).toHaveScreenshot(`${screen.name}.png`, { fullPage: true });
    });
  });
}
