import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const SCREENS = [
  { path: '/sign-in', name: 'sign-in', heading: /Your first month's money decisions/ },
  { path: '/dev/kit', name: 'kit', heading: 'Component kit' },
] as const;

/** Collect console errors and uncaught exceptions for the life of the page. */
function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function open(page: Page, path: string, heading: string | RegExp) {
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
      await open(page, screen.path, screen.heading);

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
      await open(page, screen.path, screen.heading);
      await expect(page).toHaveScreenshot(`${screen.name}.png`, { fullPage: true });
    });
  });
}
