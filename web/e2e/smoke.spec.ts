import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

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
    heading: "Where October's money went",
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

/** Serious and critical axe violations on the page as it is now. */
async function blockingViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

const screenAt = (path: string) => SCREENS.find((s) => s.path === path)!;

/**
 * Make the window tall enough that a screenshot of part of the page never
 * scrolls: scrolling would slide the sticky header over it and move the page
 * under a hovering mouse.
 */
async function tallWindow(page: Page) {
  const width = page.viewportSize()?.width ?? 1280;
  await page.setViewportSize({ width, height: 2400 });
}

/** Wait for an element's CSS animations (a popover's entrance) to finish. */
async function settled(locator: Locator) {
  await locator.evaluate((element) =>
    Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)),
  );
}

for (const screen of SCREENS) {
  test.describe(screen.path, () => {
    test('renders cleanly with no serious or critical axe violations', async ({ page }) => {
      const errors = watchErrors(page);
      await open(page, screen);
      expect(await blockingViolations(page)).toEqual([]);
      expect(errors).toEqual([]);
    });

    test('matches the visual baseline', async ({ page }) => {
      await open(page, screen);
      await expect(page).toHaveScreenshot(`${screen.name}.png`, { fullPage: true });
    });
  });
}

test.describe('the cash-flow Sankey', () => {
  test.beforeEach(({ page }) => {
    // Under 640 px the diagram is stacked bars, with no popovers.
    test.skip((page.viewportSize()?.width ?? 0) < 640, 'The Sankey is desktop only');
  });

  test('opens a node with the keyboard, moves with the arrows, and stays accessible', async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await open(page, screenAt('/dev/screens/spending'));
    const card = page.getByRole('region', { name: 'Where each dollar of October pay went' });
    const gross = card.getByRole('button', { name: 'Gross pay, 2 stubs $5,416.66' });
    await gross.focus();
    await expect(card.getByRole('group', { name: 'Gross pay, 2 stubs' })).toBeVisible();

    // Gross pay, Federal tax, Take-home, Essentials, Flexible.
    for (const key of ['ArrowRight', 'End', 'ArrowRight', 'ArrowDown']) {
      await page.keyboard.press(key);
    }
    const flexible = card.getByRole('button', { name: 'Flexible $249.89' });
    await expect(flexible).toBeFocused();
    await page.keyboard.press('ArrowRight');
    const dining = card.getByRole('group', { name: 'Dining' });
    await expect(dining).toBeVisible();
    // Mid fade-in its text is translucent, and axe would measure that contrast.
    await settled(dining);
    expect(await blockingViolations(page)).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(card.getByRole('group')).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Dining $21.00' })).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('shows a category popover on hover, matching its baseline', async ({ page }) => {
    await tallWindow(page);
    await open(page, screenAt('/dev/screens/spending'));
    const card = page.getByRole('region', { name: 'Where each dollar of October pay went' });
    await card.getByRole('button', { name: 'Shopping $204.90' }).hover();
    const shopping = card.getByRole('group', { name: 'Shopping' });
    await expect(shopping).toBeVisible();
    await settled(shopping);
    await expect(card).toHaveScreenshot('spending-sankey-popover.png');
  });
});

test('the CSV import panel opens next to the bank link and stays accessible', async ({ page }) => {
  const errors = watchErrors(page);
  await tallWindow(page);
  await open(page, screenAt('/dev/screens/link'));
  const toggle = page.getByRole('button', { name: 'Import a CSV' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const panel = page.getByRole('region', { name: 'Import a CSV' });
  await expect(panel.getByRole('button', { name: 'Import CSV' })).toBeDisabled();
  expect(await blockingViolations(page)).toEqual([]);
  await expect(panel).toHaveScreenshot('link-csv-import.png');
  expect(errors).toEqual([]);
});
