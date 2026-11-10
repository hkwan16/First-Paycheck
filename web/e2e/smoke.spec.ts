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
  /** The page's own HTTP status, when it is not 200 (the not-found page's 404). */
  status?: number;
}

const SCREENS: readonly Screen[] = [
  { path: '/sign-in', name: 'sign-in', heading: /Your first month's money decisions/ },
  {
    path: '/sign-in?deleted=1',
    name: 'sign-in-deleted',
    heading: /Your first month's money decisions/,
  },
  { path: '/dev/kit', name: 'kit', heading: 'Component kit' },
  // Any address with no page (issue 237); signed out here, so the header has no account.
  { path: '/no-such-page', name: 'not-found', heading: 'Page not found', status: 404 },
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
    heading: 'Your pay stub is confirmed',
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
  {
    path: '/dev/screens/why/emergency-fund',
    name: 'why-emergency-fund',
    heading: 'Why this decision',
    sample: true,
  },
  {
    path: '/dev/screens/why/stale',
    name: 'why-stale',
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
function watchErrors(page: Page, screen?: Screen) {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // Chromium logs a page's own non-200 status as a failed resource; that status is the point.
    const ownStatus =
      screen?.status !== undefined &&
      new URL(message.location().url).pathname === screen.path &&
      message.text().includes(`status of ${screen.status}`);
    if (!ownStatus) errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function open(page: Page, { path, heading, sample, status = 200 }: Screen) {
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
  const response = await page.goto(path);
  expect(response?.status(), `${path} answers ${status}`).toBe(status);
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
      const errors = watchErrors(page, screen);
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
    });
  });
}

test.describe('the side nav (spec 018 rules 7-10)', () => {
  test('is the whole list, with no button', async ({ page }) => {
    await open(page, screenAt('/dev/screens/decisions/401k'));
    const nav = page.getByRole('navigation', { name: 'Setup steps' });
    await expect(nav.locator('button')).toHaveCount(0);
    await expect(nav.getByRole('link', { name: /^401\(k\) match\s*, done$/ })).toBeVisible();
    await expect(nav.getByRole('link', { name: /^Plan and calendar/ })).toBeVisible();
  });
});

/**
 * Words that describe how the app works rather than what it means for the
 * person's money (issues 204 and 209). None belongs on a screen.
 */
const INTERNALS =
  /\b(prompt|explain\/v\d+|v\d+|plain code|retr(?:y|ies)|verifier|calculator|language model|AI|LLM|curated|fallback|pipeline)\b/i;

test.describe('the Why page (issue 204)', () => {
  for (const path of [
    '/dev/screens/why',
    '/dev/screens/why/stale',
    '/dev/screens/why/fallback',
    '/dev/screens/why/emergency-fund',
    '/dev/screens/why-index',
  ]) {
    test(`${path} names none of the app's internals`, async ({ page }) => {
      await open(page, screenAt(path));
      expect(await page.getByRole('main').innerText()).not.toMatch(INTERNALS);
    });
  }

  test('an out-of-date explanation is a note with a way to write it again', async ({ page }) => {
    await open(page, screenAt('/dev/screens/why/stale'));
    const note = page.getByRole('region', { name: 'About this explanation' });
    await expect(note).toContainText('has changed since');
    await expect(note.getByRole('button', { name: 'Write it again' })).toBeVisible();
    await expect(page.getByText('Out of date', { exact: true })).toHaveCount(0);
  });

  test('the side nav calls it what the page does', async ({ page }) => {
    await open(page, screenAt('/dev/screens/why-index'));
    const nav = page.getByRole('navigation', { name: 'Setup steps' });
    await expect(nav.getByRole('link', { name: 'Why each decision' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

test('the plan and the sign-in page name none of the app internals (issue 209)', async ({
  page,
}) => {
  for (const path of ['/dev/screens/plan', '/dev/screens/plan/empty']) {
    await open(page, screenAt(path));
    expect(await page.getByRole('main').innerText(), path).not.toMatch(INTERNALS);
  }
  await open(page, screenAt('/sign-in'));
  expect(await page.getByRole('main').innerText()).not.toMatch(INTERNALS);
});

test('the account menu sets deleting apart from signing out (issue 205)', async ({ page }) => {
  await open(page, screenAt('/dev/screens/account'));
  await page.getByRole('button', { name: 'J. Rivera' }).click();
  const signOut = page.getByRole('menuitem', { name: 'Sign out' });
  const remove = page.getByRole('menuitem', { name: 'Delete account' });
  await expect(page.getByRole('menu').getByRole('separator')).toBeVisible();
  const color = (locator: Locator) =>
    locator.evaluate((element) => getComputedStyle(element).color);
  const removeColor = await color(remove);
  expect(removeColor).not.toBe(await color(signOut));

  await remove.click();
  const confirm = page.getByRole('dialog', { name: 'Delete your account?' });
  await confirm.getByRole('textbox', { name: 'Type delete to confirm' }).fill('delete');
  // The final step is drawn as the destructive action, the way the menu drew it.
  expect(await color(confirm.getByRole('button', { name: 'Delete my account' }))).toBe(removeColor);
});

interface TabWalk {
  trapped: boolean;
  /** The last controls focused, for a trap's message. */
  trail: string[];
  unreached: string[];
  unseen: string[];
  obscured: string[];
}

/** Tag every control a person can Tab to with its index, and return their names. */
function tagStops(page: Page) {
  return page.evaluate(() => {
    const selector = 'a[href], button, input, select, textarea, summary, [tabindex]';
    const names: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      if (element.tabIndex < 0 || element.matches(':disabled')) continue;
      if (element instanceof HTMLInputElement && element.type === 'hidden') continue;
      if (element.closest('[inert], [hidden]')) continue;
      if (!element.checkVisibility({ visibilityProperty: true })) continue;
      element.dataset.tabStop = String(names.length);
      const label =
        element.getAttribute('aria-label') ??
        element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 40) ??
        '';
      names.push(`${element.tagName.toLowerCase()} "${label}"`);
    }
    return names;
  });
}

/**
 * The keyboard audit: tag every control a person can Tab to (in a roving
 * group only the one with tabindex 0), press Tab until focus leaves the page,
 * and report the controls never reached, those focused with no visible ring
 * (an outline on the control, or on the nearest ancestor that draws one for a
 * visually hidden input, as the drop zone does), and those the sticky header
 * covers. Focus that never leaves is a trap.
 */
async function tabWalk(page: Page): Promise<TabWalk> {
  const stops = await tagStops(page);

  const reached = new Set<number>();
  const unseen = new Set<string>();
  const obscured = new Set<string>();
  let trapped = true;
  let previous: number | null = null;
  const trail: string[] = [];
  // Controls that appear on focus (a row's Save and Cancel) are extra stops, so allow for them.
  for (let press = 0; press < 2 * stops.length + 20; press += 1) {
    await page.keyboard.press('Tab');
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
  return {
    trapped,
    trail,
    unreached: stops.filter((_, index) => !reached.has(index)),
    unseen: [...unseen],
    obscured: [...obscured],
  };
}

test.describe('the cash-flow Sankey', () => {
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

test('the account menu is a menu the keyboard drives (issue 242)', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, screenAt('/dev/screens/account'));
  const chip = page.getByRole('button', { name: 'J. Rivera' });
  await expect(chip).toHaveAttribute('aria-haspopup', 'menu');
  await chip.focus();
  await page.keyboard.press('ArrowDown');
  const menu = page.getByRole('menu', { name: 'J. Rivera' });
  await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Delete account' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: 'Delete account' })).toBeFocused();
  expect(await blockingViolations(page)).toEqual([]);

  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(chip).toBeFocused();
  await expect(chip).toHaveAttribute('aria-expanded', 'false');

  // Tab leaves the menu and closes it, so it never stays open behind the focus.
  await page.keyboard.press('Enter');
  await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('deleting the account asks in a modal dialog that holds the focus (issue 242)', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await tallWindow(page);
  await open(page, screenAt('/dev/screens/account'));
  const chip = page.getByRole('button', { name: 'J. Rivera' });
  await chip.focus();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('menuitem', { name: 'Delete account' })).toBeFocused();
  await page.keyboard.press('Enter');

  const confirm = page.getByRole('dialog', { name: 'Delete your account?' });
  await expect(page.getByRole('menu')).toHaveCount(0);
  const field = confirm.getByRole('textbox', { name: 'Type delete to confirm' });
  await expect(field).toBeFocused();
  const button = confirm.getByRole('button', { name: 'Delete my account' });
  await expect(button).toBeDisabled();
  await field.fill('delete');
  await expect(button).toBeEnabled();
  expect(await blockingViolations(page)).toEqual([]);
  await expect(confirm).toHaveScreenshot('account-delete-confirm.png');

  // The page behind is inert: Tab only cycles the dialog's own controls.
  const keep = confirm.getByRole('button', { name: 'Keep my account' });
  for (let step = 0; step < 6; step += 1) {
    await page.keyboard.press('Tab');
    const inside = await confirm.evaluate((dialog) => dialog.contains(document.activeElement));
    const atBrowser = await page.evaluate(() => document.activeElement === document.body);
    expect(inside || atBrowser, `Tab ${step + 1} stays in the dialog`).toBe(true);
  }

  await keep.focus();
  await page.keyboard.press('Enter');
  await expect(confirm).toBeHidden();
  await expect(chip).toBeFocused();

  // Escape closes it too, and starts over next time.
  await chip.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(field).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
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

  // The Sankey's popover fades instead of growing.
  await open(page, screenAt('/dev/screens/spending'));
  const card = page.getByRole('region', { name: 'Where each dollar of October pay went' });
  await card.getByRole('button', { name: 'Gross pay, 2 stubs $5,416.66' }).focus();
  await expect(card.getByRole('group', { name: 'Gross pay, 2 stubs' })).toBeVisible();
  now = await motion(page);
  expect(now.animations).not.toContain('pop-in');
  expect(now.moving).toEqual([]);
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
