import { expect, test, type Page } from '@playwright/test';
import { e2eApiUrl, NO_E2E_API } from './support/api';
import { e2eUser, NO_E2E_USER, waitForHydration } from './support/auth';

/*
 * Why pages against the real API with the saved e2e session, the way the
 * November 9 tester found issue 227: save a 401(k) rate, write its
 * explanation, save another rate over it, then open the first one's Why page.
 * It must say a newer version replaced it, link to the current one's page and
 * offer nothing that acts on the current decision; the Why index says each
 * explanation's state. The e2e user keeps its decisions between runs, so the
 * test reads each version's id from the API's answer and picks rates away
 * from whatever is saved.
 */

test.describe.configure({ mode: 'serial' });
test.skip(!e2eUser(), NO_E2E_USER);
test.skip(!e2eApiUrl(), NO_E2E_API);

const card = (page: Page) => page.getByRole('region', { name: '401(k) match' });
const result = (page: Page) => card(page).getByRole('group', { name: 'Your numbers' });
const note = (page: Page) => page.getByRole('region', { name: 'About this explanation' });

async function openStep(page: Page) {
  await page.goto('/setup/decisions/401k');
  await waitForHydration(page);
  await expect(card(page)).not.toHaveAttribute('aria-busy', 'true', { timeout: 30_000 });
  const slider = card(page).getByRole('slider', { name: /Your contribution/ });
  await expect(slider).toBeVisible({ timeout: 30_000 });
  return slider;
}

/** Save the 401(k) at `percent` through its step; the new version's id, from the API. */
async function saveRate(page: Page, percent: number): Promise<string> {
  const slider = await openStep(page);
  await slider.fill(String(percent));
  await expect(result(page)).not.toHaveAttribute('aria-busy', 'true', { timeout: 15_000 });
  const save = card(page).getByRole('button', { name: /^(Save|Save changes)$/ });
  const answer = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/decisions' && response.request().method() === 'POST',
    { timeout: 15_000 },
  );
  await save.click();
  const { decision_id: id } = (await (await answer).json()) as { decision_id: string };
  await expect(card(page).getByRole('button', { name: 'Saved' })).toBeVisible({ timeout: 15_000 });
  return id;
}

/** Open a decision's Why page and write its explanation if it has none. */
async function writeExplanation(page: Page, id: string) {
  await page.goto(`/why/${id}`);
  await waitForHydration(page);
  const write = page.getByRole('button', { name: 'Write the explanation' });
  await expect(write.or(note(page))).toBeVisible({ timeout: 30_000 });
  if (await write.isVisible()) await write.click();
  await expect(note(page)).toBeVisible({ timeout: 90_000 });
}

const k401Row = (page: Page) =>
  page
    .getByRole('list', { name: 'Saved decisions' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: '401(k) match' }) });

test('a replaced decision says so and links to the current one (issue 227)', async ({ page }) => {
  test.setTimeout(180_000);
  const start = Number(await (await openStep(page)).inputValue());
  const first = start === 7 ? 8 : 7;
  const second = first === 7 ? 8 : 7;

  const replaced = await saveRate(page, first);
  await writeExplanation(page, replaced);
  const current = await saveRate(page, second);

  await page.goto(`/why/${replaced}`);
  await waitForHydration(page);
  await expect(
    page.getByRole('heading', { level: 1, name: `Why contribute ${first}% to your 401(k)` }),
  ).toBeVisible();
  const replacedNote = page.getByRole('region', { name: 'About this decision' });
  await expect(replacedNote).toContainText('You saved a newer version of this decision on', {
    timeout: 30_000,
  });
  await expect(page.getByText('Replaced', { exact: true })).toBeVisible();
  // Nothing that acts on the current decision, and the checked note is gone.
  await expect(page.getByText(/^We checked every number here/)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Change this decision' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Write it again|Try again)$/ })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'What happens next' })).toHaveCount(0);

  await replacedNote.getByRole('link', { name: 'See the current decision' }).click();
  await expect(page).toHaveURL(`/why/${current}`);
  await waitForHydration(page);
  await expect(
    page.getByRole('heading', { level: 1, name: `Why contribute ${second}% to your 401(k)` }),
  ).toBeVisible();
  // Next keeps the replaced page in the DOM, hidden, after a client-side
  // navigation, so only what is on screen counts.
  await expect(page.getByText('Replaced', { exact: true }).filter({ visible: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('region', { name: 'About this decision' }).filter({ visible: true }),
  ).toHaveCount(0);

  // The index: the current 401(k) has no explanation yet.
  await page.goto('/why');
  await waitForHydration(page);
  await expect(k401Row(page)).toContainText('Explanation not written yet', { timeout: 30_000 });
  await expect(k401Row(page).getByRole('link', { name: '401(k) match' })).toHaveAttribute(
    'href',
    `/why/${current}`,
  );

  // Written, the current one's state reads up to date on the index.
  await writeExplanation(page, current);
  await page.goto('/why');
  await waitForHydration(page);
  await expect(k401Row(page)).toContainText(/Explanation (up to date|could not be written)/, {
    timeout: 30_000,
  });
});
