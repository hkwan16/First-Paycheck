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
  {
    path: '/sign-in?deleted=1',
    name: 'sign-in-deleted',
    heading: /Your first month's money decisions/,
  },
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
    path: '/dev/screens/confirm/unread',
    name: 'confirm-unread',
    heading: 'Enter what your pay stub says',
    sample: true,
  },
  {
    path: '/dev/screens/confirm/benefits',
    name: 'confirm-benefits',
    heading: 'Check what we read from your benefits summary',
    sample: true,
  },
  {
    path: '/dev/screens/confirm/extracting',
    name: 'confirm-extracting',
    heading: 'Check what we read from your pay stub',
    sample: true,
  },
  {
    path: '/dev/screens/confirm/failed',
    name: 'confirm-failed',
    heading: 'Check what we read from your pay stub',
    sample: true,
  },
  {
    path: '/dev/screens/confirm/confirmed',
    name: 'confirm-confirmed',
    heading: 'Check what we read from your pay stub',
    sample: true,
  },
  {
    path: '/dev/screens/account',
    name: 'account',
    heading: 'Link your accounts and add your documents',
    sample: true,
  },
  {
    path: '/dev/screens/spending',
    name: 'spending',
    heading: "Where October's money went",
    sample: true,
  },
  {
    path: '/dev/screens/decisions/emergency-fund',
    name: 'decisions-emergency-fund',
    heading: 'How much to keep for emergencies',
    sample: true,
  },
  {
    path: '/dev/screens/decisions/401k',
    name: 'decisions-401k',
    heading: 'How much to put in your 401(k)',
    sample: true,
  },
  {
    path: '/dev/screens/decisions/health-plan',
    name: 'decisions-health-plan',
    heading: 'Which health plan to choose',
    sample: true,
  },
  {
    path: '/dev/screens/decisions/w4',
    name: 'decisions-w4',
    heading: 'What to put on your W-4',
    sample: true,
  },
  {
    path: '/dev/screens/decisions/after-alpha',
    name: 'decisions-after-alpha',
    heading: 'How much to keep for emergencies',
    sample: true,
  },
  {
    path: '/dev/screens/why',
    name: 'why',
    heading: 'Why contribute 4% to your 401(k)',
    sample: true,
  },
  {
    path: '/dev/screens/why/fallback',
    name: 'why-fallback',
    heading: 'Why contribute 4% to your 401(k)',
    sample: true,
  },
  { path: '/dev/screens/why-index', name: 'why-index', heading: 'Why each decision', sample: true },
  {
    path: '/dev/screens/check-in',
    name: 'check-in',
    heading: 'November check-in',
    sample: true,
  },
  {
    path: '/dev/screens/check-in/complete',
    name: 'check-in-complete',
    heading: 'November check-in',
    sample: true,
  },
  {
    path: '/dev/screens/check-in-index',
    name: 'check-in-index',
    heading: 'Monthly check-ins',
    sample: true,
  },
  { path: '/dev/screens/plan', name: 'plan', heading: 'Your plan, on one page', sample: true },
  {
    path: '/dev/screens/plan/empty',
    name: 'plan-empty',
    heading: 'Your plan, on one page',
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

/**
 * Axe violations on the page as it is now, at every impact. The plan's gate
 * is serious and critical; the M10 audit left none of any impact, so minor
 * and moderate ones fail too and stay fixed.
 */
async function blockingViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  return violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
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
    test('renders cleanly with no axe violations', async ({ page }) => {
      const errors = watchErrors(page);
      await open(page, screen);
      expect(await blockingViolations(page)).toEqual([]);
      expect(errors).toEqual([]);
    });

    test('matches the visual baseline', async ({ page }) => {
      await open(page, screen);
      await expect(page).toHaveScreenshot(`${screen.name}.png`, { fullPage: true });
    });

    test('reaches every control by Tab with its focus visible, and lets Tab leave', async ({
      page,
    }) => {
      await open(page, screen);
      const walk = await tabWalk(page);
      expect(walk.trapped, `Tab never left the page: ${walk.trail.join(' > ')}`).toBe(false);
      expect(walk.unreached, 'controls Tab never reached').toEqual([]);
      expect(walk.unseen, 'controls focused without a visible focus ring').toEqual([]);
      expect(walk.obscured, 'controls focused under the sticky header').toEqual([]);
      // A collapsed side nav hides its links; the walk opened it and walked them too.
      expect(walk.stillCollapsed, 'side nav controls the walk never opened').toEqual([]);
    });

    test('shows its heading in the first screenful', async ({ page }) => {
      await open(page, screen);
      const viewport = page.viewportSize()!;
      const heading = await page
        .getByRole('heading', { level: 1, name: screen.heading })
        .boundingBox();
      expect(heading, 'the h1 has a box').not.toBeNull();
      expect(heading!.y + heading!.height, 'the bottom of the h1').toBeLessThanOrEqual(
        viewport.height,
      );
      // Spec 018 rule 11: under 780px the side nav is one control before the page.
      const nav = page.getByRole('navigation', { name: 'Setup steps' });
      if (sampleWithNav(screen) && viewport.width < NAV_BREAKPOINT) {
        const box = (await nav.boundingBox())!;
        expect(box.height, 'the side nav before the page').toBeLessThanOrEqual(80);
      }
    });
  });
}

/** The `nav` breakpoint token (48.75rem): the side nav collapses below it. */
const NAV_BREAKPOINT = 780;

/** The sample screens render in the app frame, with the side nav. */
const sampleWithNav = (screen: Screen) => screen.sample === true;

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < NAV_BREAKPOINT;

test.describe('the side nav (spec 018 rules 11-17)', () => {
  test('collapses to one control on a phone that opens the list in place and closes on Escape', async ({
    page,
  }) => {
    test.skip(!isPhone(page), 'The control is the phone presentation');
    const errors = watchErrors(page);
    await tallWindow(page);
    await open(page, screenAt('/dev/screens/decisions/401k'));
    const nav = page.getByRole('navigation', { name: 'Setup steps' });
    // Chromium reads each hidden comma as its own word ("match , done , 1 of 4").
    const control = nav.getByRole('button', {
      name: /^Decisions: 401\(k\) match\s*, done\s*, 1 of 4 setup steps done$/,
    });
    await expect(control).toHaveAttribute('aria-expanded', 'false');
    await expect(nav.getByRole('link', { name: 'Spending map' })).toBeHidden();

    await control.click();
    await expect(control).toHaveAttribute('aria-expanded', 'true');
    const current = nav.getByRole('link', { name: /^401\(k\) match\s*, done$/ });
    await expect(current).toBeVisible();
    await expect(current).toHaveAttribute('aria-current', 'page');
    // The page moves down under the list rather than being covered by it.
    const list = (await nav
      .locator(`#${await control.getAttribute('aria-controls')}`)
      .boundingBox())!;
    const heading = (await page.getByRole('heading', { level: 1 }).boundingBox())!;
    expect(heading.y).toBeGreaterThan(list.y + list.height);
    expect(await blockingViolations(page)).toEqual([]);
    await expect(nav).toHaveScreenshot('nav-open.png');

    await current.focus();
    await page.keyboard.press('Escape');
    await expect(control).toHaveAttribute('aria-expanded', 'false');
    await expect(control).toBeFocused();
    await expect(current).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('is the whole list at desktop width, with no control', async ({ page }) => {
    test.skip(isPhone(page), 'The list is the desktop presentation');
    await open(page, screenAt('/dev/screens/decisions/401k'));
    const nav = page.getByRole('navigation', { name: 'Setup steps' });
    const control = nav.locator('button');
    await expect(control).toHaveCount(1);
    await expect(control).toBeHidden();
    await expect(nav.getByRole('link', { name: /^401\(k\) match\s*, done$/ })).toBeVisible();
    await expect(nav.getByRole('link', { name: /^Plan and calendar/ })).toBeVisible();
  });
});

interface TabWalk {
  trapped: boolean;
  /** The last controls focused, for a trap's message. */
  trail: string[];
  unreached: string[];
  unseen: string[];
  obscured: string[];
  /** Side nav controls still collapsed when the walk ended (their links never walked). */
  stillCollapsed: string[];
}

/** The side nav's phone control while its list is collapsed (spec 018 rule 12). */
const COLLAPSED_NAV = 'nav[aria-label="Setup steps"] > button[aria-expanded="false"]';

/**
 * Tag the controls a person can Tab to that are not tagged yet, numbering on
 * from `from`, and return their names. Run again after a disclosure opens to
 * add the controls it shows.
 */
function tagStops(page: Page, from: number) {
  return page.evaluate((start) => {
    const selector = 'a[href], button, input, select, textarea, summary, [tabindex]';
    const names: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      if (element.dataset.tabStop !== undefined) continue;
      if (element.tabIndex < 0 || element.matches(':disabled')) continue;
      if (element instanceof HTMLInputElement && element.type === 'hidden') continue;
      if (element.closest('[inert], [hidden]')) continue;
      if (!element.checkVisibility({ visibilityProperty: true })) continue;
      element.dataset.tabStop = String(start + names.length);
      const label =
        element.getAttribute('aria-label') ??
        element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 40) ??
        '';
      names.push(`${element.tagName.toLowerCase()} "${label}"`);
    }
    return names;
  }, from);
}

/**
 * The keyboard audit: tag every control a person can Tab to (in a roving
 * group only the one with tabindex 0), press Tab until focus leaves the page,
 * and report the controls never reached, those focused with no visible ring
 * (an outline on the control, or on the nearest ancestor that draws one for a
 * visually hidden input, as the drop zone does), and those the sticky header
 * covers. Focus that never leaves is a trap. On a phone the side nav is a
 * collapsed disclosure: when Tab reaches its control the walk presses Enter,
 * as a person would, tags the links it shows and walks them too, so a
 * collapsed list never hides a control from the audit.
 */
async function tabWalk(page: Page): Promise<TabWalk> {
  const stops = await tagStops(page, 0);

  const reached = new Set<number>();
  const unseen = new Set<string>();
  const obscured = new Set<string>();
  let trapped = true;
  let previous: number | null = null;
  const trail: string[] = [];
  // Controls that appear on focus (a row's Save and Cancel) are extra stops, so allow for them.
  for (let press = 0; press < 2 * stops.length + 20; press += 1) {
    await page.keyboard.press('Tab');
    if (await page.evaluate((s) => document.activeElement?.matches(s), COLLAPSED_NAV)) {
      await page.keyboard.press('Enter');
      stops.push(...(await tagStops(page, stops.length)));
    }
    const focus = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element || element === document.body) return null;
      const drawsRing = (node: Element) => {
        const style = getComputedStyle(node);
        return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
      };
      let ringed = false;
      let node: Element | null = element;
      for (let depth = 0; node && depth < 4 && !ringed; depth += 1) {
        ringed = drawsRing(node);
        node = node.parentElement;
      }
      // Covered: the point at the middle of the control is the sticky header.
      const box = element.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      const header = document.querySelector('header');
      const covered =
        box.width > 1 &&
        Boolean(header && top && header.contains(top) && !header.contains(element));
      const name = `${element.tagName.toLowerCase()}#${element.id} "${(element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 30)}"`;
      return { stop: element.dataset.tabStop ?? null, ringed, covered, name };
    });
    if (focus === null) {
      trapped = false;
      break;
    }
    trail.push(focus.name);
    if (trail.length > 12) trail.shift();
    if (focus.stop === null) continue;
    const index = Number(focus.stop);
    // A date field takes one Tab per part (month, day, year) and stays focused.
    if (index === previous) continue;
    previous = index;
    if (reached.has(index)) {
      // Back at a control already reached: focus wrapped without leaving.
      break;
    }
    reached.add(index);
    if (!focus.ringed) unseen.add(stops[index]!);
    if (focus.covered) obscured.add(stops[index]!);
  }
  const stillCollapsed = await page.evaluate(
    (s) =>
      [...document.querySelectorAll<HTMLElement>(s)]
        .filter((element) => element.checkVisibility({ visibilityProperty: true }))
        .map((element) => element.textContent?.trim() ?? ''),
    COLLAPSED_NAV,
  );
  return {
    trapped,
    trail,
    unreached: stops.filter((_, index) => !reached.has(index)),
    unseen: [...unseen],
    obscured: [...obscured],
    stillCollapsed,
  };
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

test('the Confirm screen names the browser tab after the document it reviews', async ({ page }) => {
  await open(page, screenAt('/dev/screens/confirm/benefits'));
  await expect(page).toHaveTitle('Confirm benefits summary | First Paycheck');
  await open(page, screenAt('/dev/screens/confirm'));
  await expect(page).toHaveTitle('Confirm pay stub | First Paycheck');
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

test('unlinking asks in the page, keeps focus on the safe choice, and stays accessible', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await open(page, screenAt('/dev/screens/link'));
  await page.getByRole('button', { name: 'Unlink Chase' }).click();
  const confirm = page.getByRole('group', { name: 'Unlink Chase?' });
  await expect(confirm.getByRole('button', { name: 'Keep Chase' })).toBeFocused();
  expect(await blockingViolations(page)).toEqual([]);
  await page.keyboard.press('Enter');
  await expect(confirm).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Unlink Chase' })).toBeFocused();
  expect(errors).toEqual([]);
});

test('deleting the account asks for the word in the page and stays accessible', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await tallWindow(page);
  await open(page, screenAt('/dev/screens/account'));
  const chip = page.getByRole('button', { name: 'J. Rivera' });
  await chip.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const remove = page.getByRole('button', { name: 'Delete account' });
  await expect(remove).toBeFocused();
  await page.keyboard.press('Enter');

  const confirm = page.getByRole('group', { name: 'Delete your account?' });
  const field = confirm.getByRole('textbox', { name: 'Type delete to confirm' });
  await expect(field).toBeFocused();
  const button = confirm.getByRole('button', { name: 'Delete my account' });
  await expect(button).toBeDisabled();
  await field.fill('delete');
  await expect(button).toBeEnabled();
  expect(await blockingViolations(page)).toEqual([]);
  await expect(confirm).toHaveScreenshot('account-delete-confirm.png');

  await confirm.getByRole('button', { name: 'Keep my account' }).click();
  await expect(remove).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(chip).toBeFocused();
  await expect(chip).toHaveAttribute('aria-expanded', 'false');
  expect(errors).toEqual([]);
});

/**
 * What moves on the page now: the CSS animations running, by keyframes name,
 * and the elements that transition a movement (scale, rotate, translate,
 * transform) over a non-zero duration.
 */
async function motion(page: Page) {
  return page.evaluate(() => {
    const animations = document
      .getAnimations()
      .filter((animation): animation is CSSAnimation => animation instanceof CSSAnimation)
      .map((animation) => animation.animationName);
    const moving: string[] = [];
    for (const element of document.querySelectorAll('*')) {
      const style = getComputedStyle(element);
      const properties = style.transitionProperty.split(',').map((p) => p.trim());
      const durations = style.transitionDuration.split(',').map((d) => parseFloat(d));
      properties.forEach((property, index) => {
        const duration = durations[index % durations.length] ?? 0;
        if (/^(all|scale|rotate|translate|transform)$/.test(property) && duration > 0) {
          moving.push(`${element.tagName.toLowerCase()}.${property}`);
        }
      });
    }
    return { animations: [...new Set(animations)], moving: [...new Set(moving)] };
  });
}

test('reduced motion keeps feedback but drops every movement', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });

  // The indeterminate bar pulses in place instead of sliding.
  await open(page, screenAt('/dev/screens/confirm/extracting'));
  let now = await motion(page);
  expect(now.animations).toEqual(['pulse']);
  expect(now.moving).toEqual([]);

  // Buttons, the segmented control and the account menu's arrow do not move.
  await open(page, screenAt('/dev/screens/account'));
  await page.getByRole('button', { name: 'J. Rivera' }).click();
  now = await motion(page);
  expect(now.animations).toEqual([]);
  expect(now.moving).toEqual([]);

  for (const step of ['emergency-fund', '401k', 'health-plan', 'w4']) {
    await open(page, screenAt(`/dev/screens/decisions/${step}`));
    expect((await motion(page)).moving, step).toEqual([]);
  }

  // The Sankey's popover fades instead of growing (desktop only).
  if ((page.viewportSize()?.width ?? 0) >= 640) {
    await open(page, screenAt('/dev/screens/spending'));
    const card = page.getByRole('region', { name: 'Where each dollar of October pay went' });
    await card.getByRole('button', { name: 'Gross pay, 2 stubs $5,416.66' }).focus();
    await expect(card.getByRole('group', { name: 'Gross pay, 2 stubs' })).toBeVisible();
    now = await motion(page);
    expect(now.animations).not.toContain('pop-in');
    expect(now.moving).toEqual([]);
  }
});

test.describe('the net-worth card', () => {
  test('reads out every series for a month on hover, stays accessible, and matches its baseline', async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await tallWindow(page);
    await open(page, screenAt('/dev/screens/check-in'));
    const card = page.getByRole('region', { name: 'Net worth' });
    const chart = card.getByRole('figure', { name: 'Net worth by month' });
    await expect(card).toHaveScreenshot('net-worth-card.png');

    // The last month sits at the plot's right edge.
    const plot = chart.locator('.recharts-surface');
    const box = (await plot.boundingBox())!;
    await page.mouse.move(box.x + box.width - 14, box.y + box.height / 2);
    const tooltip = chart.locator('.recharts-tooltip-wrapper');
    await expect(tooltip).toContainText('Nov 2026');
    await expect(tooltip).toContainText('$5,477.54');
    await expect(tooltip).toContainText('$6,077.54');
    await expect(tooltip).toContainText('$600.00');
    expect(await blockingViolations(page)).toEqual([]);

    await card.getByText('Monthly figures').click();
    await expect(card.getByRole('table', { name: 'Net worth by month' })).toBeVisible();
    expect(errors).toEqual([]);
  });
});
