import { expect, test, type Locator, type Page } from '@playwright/test';
import { e2eApiUrl, NO_E2E_API } from './support/api';
import { e2eUser, NO_E2E_USER, waitForHydration } from './support/auth';

/*
 * The 401(k) decision against the real API with the saved e2e session, after
 * confirm.spec.ts has confirmed a pay stub: fill in the plan details if the
 * profile has none, calculate, save a version, change it and save the next
 * one over it, then open its explanation. The e2e user keeps its decisions
 * between runs (they cannot be deleted), so the test reads which version is
 * current instead of assuming v1.
 */

test.describe.configure({ mode: 'serial' });
test.skip(!e2eUser(), NO_E2E_USER);
test.skip(!e2eApiUrl(), NO_E2E_API);

const card = (page: Page) => page.getByRole('region', { name: '401(k) match' });
const result = (page: Page) => card(page).getByRole('group', { name: 'Calculator result' });
const saveButton = (page: Page) => card(page).getByRole('button', { name: /^Save|^Saved as v/ });

async function settled(page: Page) {
  await expect(result(page)).not.toHaveAttribute('aria-busy', 'true', { timeout: 15_000 });
  await expect(result(page)).toContainText(/You (capture|leave)/);
}

async function setContribution(slider: Locator, percent: number) {
  await slider.fill(String(percent));
}

test('calculates, saves a version, saves the next one over it and opens why', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/setup/decisions');
  await waitForHydration(page);
  await expect(card(page)).not.toHaveAttribute('aria-busy', 'true', { timeout: 30_000 });

  const form = card(page).getByRole('form', { name: 'Your plan details' });
  if (await form.isVisible()) {
    await form.getByLabel('Yearly salary').fill('65,000');
    await form.getByRole('button', { name: 'Single' }).click();
    await form.getByLabel('Employer adds, % of what you put in').fill('100');
    await form.getByLabel('Up to, % of your pay').fill('4');
    await form.getByRole('button', { name: 'Save plan details' }).click();
  }

  const slider = card(page).getByRole('slider', { name: /Your contribution/ });
  await expect(slider).toBeVisible({ timeout: 30_000 });
  const age = card(page).getByLabel(/Your age at the end of/);
  if ((await age.inputValue()) === '') await age.fill('30');

  // Move away from whatever is saved, so there is a version to save.
  const start = Number(await slider.inputValue());
  const first = start === 4 ? 5 : 4;
  await setContribution(slider, first);
  await settled(page);
  await expect(saveButton(page)).toBeEnabled();
  await saveButton(page).click();
  await expect(saveButton(page)).toHaveText(/^Saved as v(\d+)$/, { timeout: 15_000 });
  const saved = Number(/v(\d+)/.exec((await saveButton(page).textContent()) ?? '')![1]);

  await setContribution(slider, first === 4 ? 6 : 3);
  await settled(page);
  await expect(saveButton(page)).toHaveText(`Save as v${saved + 1}`);
  await expect(card(page).getByText(`Changed since v${saved}`)).toBeVisible();
  await saveButton(page).click();
  await expect(saveButton(page)).toHaveText(`Saved as v${saved + 1}`, { timeout: 15_000 });

  await card(page).getByRole('link', { name: 'Why this decision' }).click();
  await expect(page).toHaveURL(/\/why\/[^/]+$/);
  await waitForHydration(page);
  await expect(page.getByText(`401(k) match · decision v${saved + 1}`)).toBeVisible();

  const none = page.getByRole('region', { name: 'No explanation yet' });
  const verified = page.getByText('Verified against calculator');
  const fallback = page.getByText('Could not verify the explanation');
  await expect(verified.or(fallback).or(none)).toBeVisible({ timeout: 30_000 });
  if (await none.isVisible()) {
    await none.getByRole('button', { name: 'Write the explanation' }).click();
  }
  // Verified, a fallback, or no model configured on this API: each is an answer.
  await expect(
    verified.or(fallback).or(page.getByText('Explanations are not available yet.')),
  ).toBeVisible({ timeout: 90_000 });
});
