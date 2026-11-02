import { existsSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { openLink } from './support/api';
import { STORAGE_STATE, waitForHydration } from './support/auth';
import {
  CAPTURE_DIR,
  confirmAcmeFields,
  DESKTOP,
  NO_CAPTURE_DIR,
  proposalOf,
  settled,
  stubRow,
  uploadAcmeStub,
} from './support/capture';
import { Demo, DEMO_MP4, DEMO_SIZE, toMp4 } from './support/demo';

/*
 * The alpha document's two-minute demo: one continuous recording of a person
 * going through the product, with a caption naming each scene, converted to
 * docs/alpha/alpha-demo.mp4 (E2E_DEMO_MP4 elsewhere). It reads the e2e
 * account's data as the other capture projects leave it (a linked bank,
 * confirmed stubs, saved decisions, a check-in) and signs in only from the
 * saved session, so no email or password is ever typed on camera.
 *
 * Off camera first, in a window of its own, it uploads the synthetic Acme
 * stub (replacing any stub left waiting for review) and waits for the worker
 * to read it, because how long the model takes is not something to watch.
 * On camera it confirms that stub, saves the next 401(k) version, and opens
 * that version's explanation, which the off-camera window starts writing as
 * soon as the version is saved. Those are the only changes it makes: a new
 * confirmed stub with the same values, a decision version and its
 * explanation. Until a second confirmed copy of a stub stops counting again
 * (docs/backlog.yaml), each run adds the Acme stub to October's cash flow once more.
 */
test.skip(!CAPTURE_DIR, NO_CAPTURE_DIR);
test.skip(
  !existsSync(STORAGE_STATE),
  'Skipped: no saved session at web/e2e/.auth/user.json. Run the setup project once (see playwright.capture.config.ts).',
);

const nav = (page: Page) => page.getByRole('navigation', { name: 'Setup steps' });

/**
 * Write the decision's explanation from another window while the recording
 * goes on, as the Why screen's own button does. A draft the verifier rejects
 * shows the calculator's result instead; it is asked for once more, which is
 * what "Try again" offers anyone.
 */
async function writeExplanation(page: Page, whyHref: string) {
  await page.goto(whyHref);
  await waitForHydration(page);
  const verified = page.getByText(/^We checked every number here/);
  const fallback = page.getByText(/^We could not write an explanation/);
  const unavailable = page.getByText('Explanations are not available right now.');
  const none = page.getByRole('region', { name: 'No explanation yet' });
  await expect(verified.or(fallback).or(none)).toBeVisible({ timeout: 60_000 });
  if (await none.isVisible()) {
    await none.getByRole('button', { name: 'Write the explanation' }).click();
  }
  await expect(verified.or(fallback).or(unavailable)).toBeVisible({ timeout: 180_000 });
  if (await fallback.isVisible()) {
    const answer = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/explain' && response.request().method() === 'POST',
      { timeout: 180_000 },
    );
    await page.getByRole('button', { name: 'Try again' }).click();
    await answer;
    await expect(verified.or(fallback)).toBeVisible({ timeout: 30_000 });
  }
}

test('records the alpha demo', async ({ browser }, testInfo) => {
  test.setTimeout(900_000);

  // Off camera: a stub for the recording to confirm, read before it starts.
  const offCamera = await browser.newContext({ storageState: STORAGE_STATE, viewport: DESKTOP });
  const helper = await offCamera.newPage();
  // An expired session lands on sign-in; say so before waiting on the accounts.
  await helper.goto('/setup/link');
  await expect(
    helper,
    'The saved session has expired: run the setup project once (see playwright.capture.config.ts)',
  ).toHaveURL((url) => url.pathname === '/setup/link');
  await openLink(helper);
  const documentId = await uploadAcmeStub(helper);

  const context = await browser.newContext({
    storageState: STORAGE_STATE,
    viewport: DEMO_SIZE,
    recordVideo: { dir: testInfo.outputPath('video'), size: DEMO_SIZE },
  });
  const page = await context.newPage();
  const recordingStarted = Date.now();
  const demo = new Demo(page);
  await demo.start();

  // The first screen loads before the film starts: the MP4 is cut from here.
  await openLink(page);
  await settled(page);
  const filmStarts = (Date.now() - recordingStarted) / 1000;

  // 1. The linked bank and the documents.
  await demo.scene(
    '1. Link a bank and add a pay stub',
    'Accounts sync from the bank (the Plaid sandbox). The stub is redacted before the AI reads it.',
  );
  await demo.hold(3000);
  const row = stubRow(page, documentId);
  await demo.scrollTo(row);
  await demo.hold(2500);

  // 2. Confirm the stub: the AI's proposals beside the redacted lines.
  const proposal = proposalOf(page, documentId);
  await row.getByRole('link').first().click();
  await expect(page).toHaveURL(`/setup/confirm/${documentId}`);
  await waitForHydration(page);
  const fields = await proposal;
  await demo.scene(
    '2. Confirm the pay stub',
    'Each value the AI read is only a proposal. Select one to see its line on the redacted stub.',
  );
  const card = page.getByRole('region', { name: /^(What we read|Pay stub details)$/ });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await demo.hold(2500);
  const gross = card.getByRole('group', { name: 'Gross pay', exact: true }).getByRole('button');
  if (await gross.first().isVisible()) {
    await gross.first().click();
    await demo.hold(2500);
  }
  await demo.scene(
    '2. Confirm the pay stub',
    'Confirm what matches the stub and type what is missing. Nothing counts until you confirm it.',
  );
  await confirmAcmeFields(page, fields, { pause: 900, typingDelay: 110 });
  await demo.scrollTo(card.getByText('The math checks out.'));
  await demo.hold(1800);
  await page.getByRole('button', { name: /Confirm and continue/ }).click();

  // 3. Spending: the tiles, the cash flow and who labeled each transaction.
  await expect(page).toHaveURL('/setup/spending', { timeout: 30_000 });
  await demo.scene(
    '3. See where the money went',
    'Spending comes from the bank’s transactions; gross pay and deductions from the confirmed stub.',
  );
  await settled(page);
  // October holds the Acme stub's pay date, so the diagram starts from its gross pay.
  const picker = page.getByRole('combobox', { name: 'Period' });
  const october = picker.locator('option', { hasText: /^Oct/ });
  if ((await october.count()) > 0) {
    const label = (await october.first().textContent()) ?? '';
    if ((await picker.locator('option:checked').textContent()) !== label) {
      await picker.selectOption({ label });
      await settled(page);
    }
  }
  await demo.hold(3000);
  const flow = page.getByRole('region', { name: /^Where each dollar of (\w+ )?pay went$/ });
  await demo.scrollTo(flow, 'start');
  // A bucket's details: the categories its money went to.
  const node = flow.getByRole('button', { name: /^Essentials \$/ });
  if ((await node.count()) > 0) {
    await node.hover();
    await expect(flow.getByRole('group')).toHaveCount(1);
    await demo.hold(3500);
    await page.keyboard.press('Escape');
  }
  await demo.scene(
    '3. See where the money went',
    'Each transaction says who labeled it: the AI with its confidence, a rule, or you.',
  );
  const transactions = page.getByRole('region', { name: 'Transactions' });
  await demo.scrollTo(transactions, 'start');
  await demo.hold(3500);

  // 4. The four decisions, one calculator each.
  await demo.scene(
    '4. Make four decisions',
    'Each one is a calculator in tested code. The AI never does the math.',
  );
  await page.getByRole('link', { name: /Use these numbers in decisions/ }).click();
  await expect(page).toHaveURL('/setup/decisions/emergency-fund');
  await settled(page);
  await demo.hold(2500);

  await page.getByRole('link', { name: 'Next: 401(k) match' }).click();
  await expect(page).toHaveURL('/setup/decisions/401k');
  await demo.scene(
    '4. Make four decisions: the 401(k)',
    'Moving the slider reruns the calculator. Saving keeps a new version of the decision.',
  );
  const k401 = page.getByRole('region', { name: '401(k) match' });
  const slider = k401.getByRole('slider', { name: /Your contribution/ });
  await expect(slider).toBeVisible({ timeout: 60_000 });
  await settled(page);
  await demo.hold(1500);
  // To 4% (5% when 4% is saved), so there is a version to save, a step at a
  // time from the keyboard. Focused, not clicked: a click on a range input
  // moves its thumb to wherever the pointer lands.
  const start = Number(await slider.inputValue());
  const target = start === 4 ? 5 : 4;
  const key = target > start ? 'ArrowRight' : 'ArrowLeft';
  await slider.hover();
  await slider.focus();
  for (let step = 0; step < Math.abs(target - start); step += 1) {
    await page.keyboard.press(key);
    await demo.hold(350);
  }
  const save = k401.getByRole('button', { name: /^Save|^Saved as v/ });
  await expect(save).toHaveText(/^Save as v\d+$/, { timeout: 30_000 });
  await expect(save).toBeEnabled({ timeout: 30_000 });
  await demo.hold(1500);
  await save.click();
  await expect(save).toHaveText(/^Saved as v\d+$/, { timeout: 30_000 });
  const whyHref = await k401.getByRole('link', { name: 'Why this decision' }).getAttribute('href');
  expect(whyHref).toMatch(/^\/why\/[^/]+$/);
  // The explanation is written off camera while the recording goes on.
  const explained = writeExplanation(helper, whyHref!);
  await demo.hold(2000);

  await demo.scene(
    '4. Make four decisions: the health plan',
    'Your plans compared by yearly cost at the use you expect, with the HSA’s tax savings.',
  );
  await page.getByRole('link', { name: 'Next: health plan' }).click();
  await expect(page).toHaveURL('/setup/decisions/health-plan');
  await settled(page);
  await demo.scrollTo(page.getByRole('table', { name: 'Expected yearly cost by plan' }));
  await demo.hold(3500);

  await demo.scene(
    '4. Make four decisions: the W-4',
    'It reads the saved 401(k) and health plan, and shows what changes at tax time.',
  );
  await page.getByRole('link', { name: 'Next: W-4' }).click();
  await expect(page).toHaveURL('/setup/decisions/w4');
  await settled(page);
  const w4 = page.getByRole('region', { name: 'W-4, federal only' });
  await demo.scrollTo(w4.getByRole('group', { name: 'From your decisions' }));
  await demo.hold(2500);
  // The result, not "If you change nothing": that comparison needs the stub and
  // the plan details on one pay schedule, and the Acme stub is semimonthly.
  await demo.scrollTo(w4.getByRole('group', { name: 'Calculator result' }));
  await demo.hold(2500);

  // 5. Why: the 401(k) version just saved, explained and checked.
  await explained;
  await nav(page)
    .getByRole('link', { name: /^Why each decision/ })
    .click();
  await expect(page).toHaveURL('/why');
  await settled(page);
  await page.getByRole('link', { name: '401(k) match', exact: true }).click();
  await expect(page).toHaveURL(whyHref!);
  await demo.scene(
    '5. Why: an explanation checked against the calculator',
    'The AI explains the decision; plain code checks every number and the IRS source it cites.',
  );
  await settled(page);
  await demo.hold(3500);
  const sources = page.getByRole('region', { name: 'Sources' });
  if (await sources.isVisible()) {
    await demo.scrollTo(sources);
    await demo.hold(3000);
  }

  // 6. The plan.
  await nav(page)
    .getByRole('link', { name: /^Plan and calendar/ })
    .click();
  await expect(page).toHaveURL('/plan');
  await demo.scene(
    '6. The plan on one page',
    'Every saved decision, the paycheck, goals and the next 90 days, ready to export as a PDF.',
  );
  await settled(page);
  await demo.hold(2500);
  await demo.scrollTo(page.getByRole('region', { name: 'Next 90 days' }));
  await demo.hold(2500);

  // 7. The monthly check-in.
  await nav(page)
    .getByRole('link', { name: /^Monthly check-in/ })
    .click();
  await expect(page).toHaveURL(/\/check-in(\/[^/]+)?$/);
  if (new URL(page.url()).pathname === '/check-in') {
    await settled(page);
    await page.getByRole('list', { name: 'Check-ins' }).getByRole('link').first().click();
  }
  await expect(page.getByRole('heading', { level: 1, name: /check-in$/ })).toBeVisible({
    timeout: 30_000,
  });
  await demo.scene(
    '7. The monthly check-in',
    'Each month it checks whether the decisions took effect and lists what changed.',
  );
  await settled(page);
  await demo.hold(2500);
  // Early in a month its own check-in has little to compare yet: the cash flow
  // against the plan is shown from the month before when there is one.
  await page.getByRole('link', { name: 'All check-ins' }).click();
  await expect(page).toHaveURL('/check-in');
  await settled(page);
  const months = page.getByRole('list', { name: 'Check-ins' }).getByRole('link');
  await demo.hold(1500);
  await months.nth((await months.count()) > 1 ? 1 : 0).click();
  await expect(page.getByRole('heading', { level: 1, name: /check-in$/ })).toBeVisible({
    timeout: 30_000,
  });
  await settled(page);
  await demo.scrollTo(page.getByRole('region', { name: /cash flow against your plan$/ }), 'start');
  await demo.hold(3500);

  await demo.scrollTop();
  await demo.scene(
    'First Paycheck',
    'Every number comes from tested code. What the AI produces is a proposal until you confirm it.',
  );
  await demo.hold(3000);
  await demo.end();

  const video = page.video();
  await context.close();
  await offCamera.close();
  if (!video) throw new Error('The recording context made no video');
  const bytes = await toMp4(await video.path(), DEMO_MP4, filmStarts);
  testInfo.annotations.push({
    type: 'demo',
    description: `${DEMO_MP4}: ${(bytes / 1_000_000).toFixed(1)} MB`,
  });
});
