import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { waitForHydration } from './auth';

/** Where the capture specs write their PNGs; they skip without it. */
export const CAPTURE_DIR = process.env.E2E_CAPTURE_DIR?.trim() || null;

export const NO_CAPTURE_DIR =
  'Skipped: set E2E_CAPTURE_DIR to the folder the screenshots go in (docs/alpha/screenshots).';

export const DESKTOP = { width: 1280, height: 820 };

/** Save a full-page screenshot of the page, or one of a single element. */
export async function shot(target: Page | Locator, name: string) {
  if (!CAPTURE_DIR) throw new Error(NO_CAPTURE_DIR);
  mkdirSync(CAPTURE_DIR, { recursive: true });
  const file = path.join(CAPTURE_DIR, `${name}.png`);
  if ('goto' in target) await target.screenshot({ path: file, fullPage: true });
  else await target.screenshot({ path: file });
}

/**
 * Hydrated, no request in flight, and no region on screen still marked busy.
 * Hidden ones do not count: after a client-side navigation Next keeps the
 * previous page in the DOM, hidden, as it was when it was left (the Confirm
 * screen's button still loading, for one).
 */
export async function settled(page: Page) {
  await waitForHydration(page);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('[aria-busy="true"]').filter({ visible: true })).toHaveCount(0, {
    timeout: 60_000,
  });
}

/** The synthetic Acme stub (e2e/fixtures/make-acme-paystub.mjs). */
export const ACME_STUB = path.join(__dirname, '..', 'fixtures', 'acme-paystub.pdf');

/**
 * What the Acme stub prints, by the API's field key: `value` as the proposal
 * holds it (cents, ISO dates, the frequency's enum), `typed` as a person
 * types it. Its 401(k) line is a dash, which is 0; other deductions are its
 * CA SDI and dental lines, which the API adds up.
 */
const ACME: Record<string, { value: number | string; typed: string }> = {
  employer_name: { value: 'Acme Corp', typed: 'Acme Corp' },
  pay_date: { value: '2026-10-15', typed: '2026-10-15' },
  period_start: { value: '2026-10-01', typed: '2026-10-01' },
  period_end: { value: '2026-10-15', typed: '2026-10-15' },
  pay_frequency: { value: 'semimonthly', typed: 'semimonthly' },
  gross_cents: { value: 270833, typed: '2,708.33' },
  federal_withholding_cents: { value: 29776, typed: '297.76' },
  social_security_cents: { value: 16792, typed: '167.92' },
  medicare_cents: { value: 3927, typed: '39.27' },
  state_tax_cents: { value: 9814, typed: '98.14' },
  retirement_contribution_cents: { value: 0, typed: '0' },
  medical_premium_cents: { value: 6250, typed: '62.50' },
  other_deductions_cents: { value: 4670, typed: '46.70' },
  net_cents: { value: 199604, typed: '1,996.04' },
};

const documentsCard = (page: Page) => page.getByRole('region', { name: 'Documents' });

/** A pay stub row whose link opens it on Confirm (read and waiting, or in manual entry). */
const REVIEW_LINK = /^(Review pay stub|Enter pay stub fields)$/;

/**
 * On the Link screen: upload the Acme stub and wait until it has been read,
 * returning the new document's id. A pay stub already waiting for review (an
 * earlier run's, or one read before a model was configured) is replaced by
 * the upload, through its row's Replace, so the list keeps one stub to
 * review. The new row is found by its id, never by its place in the list.
 */
export async function uploadAcmeStub(page: Page): Promise<string> {
  const docs = documentsCard(page);
  const stubs = docs.getByRole('group', { name: /^Pay stub/ });
  await expect(stubs.first().or(docs.getByText(/^No documents yet/))).toBeVisible({
    timeout: 60_000,
  });
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/docs' && response.request().method() === 'POST',
    { timeout: 120_000 },
  );
  const waiting = stubs.filter({ has: page.getByRole('link', { name: REVIEW_LINK }) }).first();
  if ((await waiting.count()) > 0) {
    const chooser = page.waitForEvent('filechooser');
    await waiting.getByRole('button', { name: 'Replace pay stub' }).click();
    await (await chooser).setFiles(ACME_STUB);
  } else {
    await docs.getByLabel('Document type').selectOption('pay_stub');
    await docs.getByLabel(/Add (another|a) document/).setInputFiles(ACME_STUB);
  }
  const response = await created;
  if (!response.ok()) {
    // Most likely the upload limit (10 an hour per user, a 429 with Retry-After).
    const retry = response.headers()['retry-after'];
    throw new Error(
      `The pay stub upload was refused (${response.status()}): ${await response.text()}` +
        (retry ? ` Try again in ${Math.ceil(Number(retry) / 60)} minutes.` : ''),
    );
  }
  const { document_id: id } = (await response.json()) as { document_id: string };
  // Reading is a worker job: the row links to Confirm once it is done.
  await expect(docs.locator(`a[href="/setup/confirm/${id}"]`)).toBeVisible({ timeout: 240_000 });
  return id;
}

/** The pay stub row of document `id` on the Link screen. */
export const stubRow = (page: Page, id: string) =>
  documentsCard(page)
    .getByRole('group', { name: /^Pay stub/ })
    .filter({ has: page.locator(`a[href="/setup/confirm/${id}"]`) });

interface ProposedField {
  key: string;
  label: string;
  value: number | string | null;
}

/**
 * Wait for the Confirm screen's read of document `id` and return its proposed
 * fields. Call before opening the screen.
 */
export function proposalOf(page: Page, id: string): Promise<ProposedField[]> {
  return page
    .waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/docs/${id}` &&
        response.request().method() === 'GET' &&
        response.ok(),
      { timeout: 60_000 },
    )
    .then(async (response) => {
      const body = (await response.json()) as { proposal: { fields?: ProposedField[] } | null };
      return body.proposal?.fields ?? [];
    });
}

export interface ConfirmPace {
  /** Milliseconds between steps a viewer should see (0 for screenshots). */
  pause: number;
  /** Milliseconds between typed characters. */
  typingDelay: number;
}

/**
 * On the Confirm screen, check every proposed value against what the Acme
 * stub prints, as a careful person would: confirm the values that match all
 * at once, and type each one that is missing (its 401(k) line is a dash) or
 * was read wrong. With no model the screen is in manual entry and every field
 * is typed. Ends when the math checks out; does not continue.
 */
export async function confirmAcmeFields(
  page: Page,
  fields: ProposedField[],
  pace: ConfirmPace = { pause: 0, typingDelay: 0 },
) {
  const card = page.getByRole('region', { name: /^(What we read|Pay stub details)$/ });
  await expect(card).toBeVisible({ timeout: 30_000 });
  const wrong = fields.filter((field) => {
    const expected = ACME[field.key];
    return expected !== undefined && field.value !== expected.value;
  });
  const confirmAll = page.getByRole('button', { name: 'Confirm all remaining' });
  // Manual entry: every row is already open, so there is nothing to confirm at once.
  if (await confirmAll.isEnabled()) {
    // A wrong value is corrected before the rest are confirmed together.
    for (const field of wrong) {
      const edit = card.getByRole('button', { name: `Edit ${field.label}`, exact: true });
      if (await edit.isVisible()) await typeField(page, card, field, pace);
    }
    await confirmAll.click();
    await page.waitForTimeout(pace.pause);
  }
  // What is left open: fields the stub does not print, or every field in manual entry.
  for (const field of fields) {
    const confirmed = card.getByRole('button', { name: `Confirmed ${field.label}`, exact: true });
    if (await confirmed.isVisible()) continue;
    await typeField(page, card, field, pace);
  }
  await expect(card.getByText('The math checks out.')).toBeVisible();
}

async function typeField(page: Page, card: Locator, field: ProposedField, pace: ConfirmPace) {
  const expected = ACME[field.key];
  if (!expected) throw new Error(`The Acme stub has no value for ${field.label} (${field.key})`);
  const edit = card.getByRole('button', { name: `Edit ${field.label}`, exact: true });
  if (await edit.isVisible()) await edit.click();
  const control = card
    .getByRole('group', { name: field.label, exact: true })
    .getByLabel(field.label, { exact: true });
  const kind = await control.evaluate((element) =>
    element.tagName === 'SELECT' ? 'select' : (element as HTMLInputElement).type,
  );
  if (kind === 'select') {
    await control.selectOption(expected.typed);
  } else if (kind === 'date') {
    // A date input takes its value whole; typed keys go to its segments.
    await control.fill(expected.typed);
  } else {
    await control.fill('');
    await control.pressSequentially(expected.typed, { delay: pace.typingDelay });
  }
  await page.waitForTimeout(pace.pause / 2);
  await control.press('Enter');
  await expect(
    card.getByRole('button', { name: `Confirmed ${field.label}`, exact: true }),
  ).toBeVisible();
}
