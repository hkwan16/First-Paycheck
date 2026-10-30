import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  e2eApiUrl,
  linkSandboxBank,
  NO_E2E_API,
  NO_PLAID_SANDBOX,
  openLink,
  plaidSandboxAvailable,
} from './support/api';
import { alphaUser, NO_ALPHA_USER, submitSignIn, waitForHydration } from './support/auth';

/*
 * The alpha, end to end, as a new user against the real API (docs/plan.md,
 * "Verification"): sign in, link Plaid's sandbox bank and fix a category,
 * upload the synthetic Acme pay stub and confirm it, read the Spending tiles,
 * step on to the 401(k), save its decision at 4% as v1 and a change as v2, then read why.
 *
 * The account must be new (scripts/e2e_stack.py makes one per run; against a
 * hosted API, create a fresh confirmed user), because the decision versions
 * are asserted exactly. Without Plaid sandbox keys the link steps are skipped
 * and noted on the test. Every wait follows what the screen says (job
 * progress, saved badges, the explanation's status), never a timer.
 */

const FIXTURE = path.join(__dirname, 'fixtures', 'acme-paystub.pdf');

test.skip(!alphaUser(), NO_ALPHA_USER);
test.skip(!e2eApiUrl(), NO_E2E_API);

const card = (page: Page) => page.getByRole('region', { name: '401(k) match' });
const result = (page: Page) => card(page).getByRole('group', { name: 'Calculator result' });
const saveButton = (page: Page) => card(page).getByRole('button', { name: /^Save|^Saved as v/ });

/** The calculator has answered for the inputs on screen. */
async function settled(page: Page) {
  await expect(result(page)).not.toHaveAttribute('aria-busy', 'true', { timeout: 15_000 });
  await expect(result(page)).toContainText(/(You|you would) (capture|leave)/);
}

async function setContribution(page: Page, slider: Locator, percent: number) {
  await slider.fill(String(percent));
  await expect(slider).toHaveValue(String(percent));
  await settled(page);
}

test('a new user goes from sign-in to a verified 401(k) explanation', async ({ page }) => {
  test.setTimeout(300_000);
  const user = alphaUser()!;

  await test.step('sign in through the form and land on the first setup step', async () => {
    await page.goto('/sign-in');
    await submitSignIn(page, user.email, user.password);
    await expect(page).toHaveURL('/setup/link');
    await expect(page.getByRole('button', { name: user.email })).toBeVisible();
    await openLink(page);
    await expect(page.getByText(/No accounts linked yet/)).toBeVisible();
  });

  if (plaidSandboxAvailable()) {
    await test.step('link the sandbox bank and follow its sync', async () => {
      await linkSandboxBank(page);
      await expect(page.getByRole('progressbar')).toHaveCount(0);
    });

    await test.step('see transactions with source badges and fix a category', async () => {
      await page.getByRole('link', { name: /Continue to spending/ }).click();
      await expect(page).toHaveURL('/setup/spending');
      await waitForHydration(page);
      const table = page.getByRole('table', { name: 'Transactions' });
      await expect(table).toBeVisible({ timeout: 30_000 });
      expect(await table.getByRole('row').count()).toBeGreaterThan(2);
      await expect(table.getByText(/^(Rule|You|AI( · \d+%)?|Not labeled)$/).first()).toBeVisible();

      const select = table.getByRole('combobox').first();
      const target = (await select.inputValue()) === 'entertainment' ? 'Dining' : 'Entertainment';
      await select.selectOption(target);
      await expect(select).toHaveValue(target.toLowerCase());
      await expect(page.getByText(/^Saved as a rule\./)).toBeVisible({ timeout: 15_000 });
    });
  } else {
    test.info().annotations.push({ type: 'skipped steps', description: NO_PLAID_SANDBOX });
  }

  await test.step('upload the pay stub and see what was redacted', async () => {
    await openLink(page);
    const docs = page.getByRole('region', { name: 'Documents' });
    await docs.getByLabel('Document type').selectOption('pay_stub');
    await docs.getByLabel(/Add (another|a) document/).setInputFiles(FIXTURE);

    const row = docs.getByRole('group', { name: /^Pay stub/ }).first();
    await expect(row.getByText('Review needed')).toBeVisible({ timeout: 180_000 });
    await expect(row.getByText(/^[1-9]\d* items? redacted$/)).toBeVisible();
    await row.getByRole('link', { name: 'Review pay stub' }).click();
  });

  await test.step('confirm every field with the math checking out', async () => {
    await expect(page).toHaveURL(/\/setup\/confirm\/[^/]+$/);
    await waitForHydration(page);
    const fields = page.getByRole('region', { name: 'Extracted fields' });
    await expect(fields).toBeVisible();
    await expect(
      page.getByRole('complementary', { name: 'Source, as the AI saw it' }).getByRole('img', {
        name: 'Redacted',
      }),
    ).not.toHaveCount(0);

    await page.getByRole('button', { name: 'Confirm all remaining' }).click();
    // A field the stub does not print (its 401(k) line is a dash) stays open:
    // type what the stub says, which is nothing.
    const unconfirmed = fields.getByRole('button', { name: /^Confirm (?!all)/ });
    while ((await unconfirmed.count()) > 0) {
      const label = ((await unconfirmed.first().getAttribute('aria-label')) ?? '').replace(
        /^Confirm /,
        '',
      );
      await fields.getByRole('button', { name: `Edit ${label}`, exact: true }).click();
      const input = fields
        .getByRole('group', { name: label, exact: true })
        .getByLabel(label, { exact: true });
      if ((await input.inputValue()) === '') await input.fill('0');
      await input.press('Enter');
      await expect(
        fields.getByRole('button', { name: `Confirmed ${label}`, exact: true }),
      ).toBeVisible();
    }

    await expect(fields.getByText('The math checks out.')).toBeVisible();
    await page.getByRole('button', { name: /Confirm and continue/ }).click();
    await expect(page).toHaveURL('/setup/spending', { timeout: 30_000 });
  });

  await test.step('see the Spending tiles', async () => {
    await waitForHydration(page);
    const summary = page.getByRole('region', { name: /Your month so far|pay stubs?$/ });
    await expect(summary).toBeVisible();
    for (const tile of ['Income', 'Essentials', 'Flexible', 'Savings']) {
      await expect(summary.getByText(tile, { exact: true })).toBeVisible();
    }
  });

  await test.step('save the 401(k) contribution at 4% as v1', async () => {
    // Decisions is four steps (spec 018); the 401(k) is the second.
    await page.getByRole('link', { name: /Use these numbers in decisions/ }).click();
    await expect(page).toHaveURL('/setup/decisions/emergency-fund');
    await waitForHydration(page);
    await expect(page.getByText('0 of 4 saved')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('link', { name: 'Next: 401(k) match' }).click();
    await expect(page).toHaveURL('/setup/decisions/401k');
    await waitForHydration(page);

    // A new profile has no salary or match yet; the card asks for them.
    const form = card(page).getByRole('form', { name: 'Your plan details' });
    await expect(form).toBeVisible({ timeout: 30_000 });
    await form.getByLabel('Yearly salary').fill('65,000');
    await form.getByRole('button', { name: 'Single' }).click();
    await form.getByLabel('Employer adds, % of what you put in').fill('100');
    await form.getByLabel('Up to, % of your pay').fill('4');
    // The calculator's age comes from the birth year (spec 006 open question 2, settled in M6).
    await form.getByLabel('Year you were born').fill('1996');
    await form.getByRole('button', { name: 'Save plan details' }).click();

    const slider = card(page).getByRole('slider', { name: /Your contribution/ });
    await expect(slider).toBeVisible({ timeout: 30_000 });
    await setContribution(page, slider, 4);
    await expect(saveButton(page)).toBeEnabled();
    await saveButton(page).click();
    await expect(saveButton(page)).toHaveText('Saved as v1', { timeout: 15_000 });
    await expect(page.getByText('1 of 4 saved')).toBeVisible();
  });

  await test.step('change it and save v2 over v1', async () => {
    const slider = card(page).getByRole('slider', { name: /Your contribution/ });
    await setContribution(page, slider, 6);
    await expect(card(page).getByText('Changed since v1')).toBeVisible();
    await expect(saveButton(page)).toHaveText('Save as v2');
    await saveButton(page).click();
    await expect(saveButton(page)).toHaveText('Saved as v2', { timeout: 15_000 });
  });

  await test.step('open why and see the explanation verified against the calculator', async () => {
    await card(page).getByRole('link', { name: 'Why this decision' }).click();
    await expect(page).toHaveURL(/\/why\/[^/]+$/);
    await waitForHydration(page);
    await expect(page.getByText('401(k) match · decision v2')).toBeVisible();

    const none = page.getByRole('region', { name: 'No explanation yet' });
    await none.getByRole('button', { name: 'Write the explanation' }).click();
    // The local stack runs LLM_FAKE=true: the fake drafts from the facts it is
    // given and cites the first passage, so the verifier accepts it.
    await expect(page.getByText('Verified against calculator')).toBeVisible({ timeout: 90_000 });
    const sources = page.getByRole('region', { name: 'Sources' });
    await expect(sources.getByRole('link').first()).toHaveAttribute(
      'href',
      /^https:\/\/www\.irs\.gov\//,
    );
  });
});
