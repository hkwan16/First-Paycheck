import type { Account, Job, Transaction } from '@/lib/api/types';

/*
 * The mockup's sample data (docs/mockup/canvas.json, "sample" note) in the
 * API's shapes: J. Rivera at Acme Corp, two Chase accounts, and the sixteen
 * October transactions from Spending.dc.html. Invented, never a real person.
 *
 * Amounts follow the API: integer cents, Plaid's sign (> 0 is money out).
 */

export const SAMPLE_USER = { name: 'J. Rivera', employer: 'Acme Corp', frequency: 'Semi-monthly' };

export const CHASE_ITEM_ID = '0b9a7c55-7f9e-4c1a-9b8f-1c2d3e4f5a01';
export const CHECKING_ID = '1a2b3c4d-0000-4000-8000-000000004821';
export const SAVINGS_ID = '1a2b3c4d-0000-4000-8000-000000007730';

/** When the sample sync ran; the dev screens freeze the clock four minutes later. */
export const SAMPLE_SYNCED_AT = '2026-10-17T15:56:00Z';
export const SAMPLE_NOW = '2026-10-17T16:00:00Z';

export const sampleAccounts: readonly Account[] = [
  {
    id: CHECKING_ID,
    sync_item_id: CHASE_ITEM_ID,
    provider: 'plaid',
    institution_name: 'Chase',
    name: 'Chase Total Checking',
    kind: 'checking',
    mask: '4821',
    role: 'spending',
    is_active: true,
    balance_cents: 318_212,
    balance_as_of: SAMPLE_SYNCED_AT,
  },
  {
    id: SAVINGS_ID,
    sync_item_id: CHASE_ITEM_ID,
    provider: 'plaid',
    institution_name: 'Chase',
    name: 'Chase Savings',
    kind: 'savings',
    mask: '7730',
    role: 'emergency_fund',
    is_active: true,
    balance_cents: 214_000,
    balance_as_of: SAMPLE_SYNCED_AT,
  },
];

type Row = [
  day: number,
  merchant: string,
  cents: number,
  category: Transaction['category'],
  source: Transaction['category_source'],
  confidence: number | null,
];

// Spending.dc.html's table. Blue Bottle is labeled by the user so every
// source badge appears; the mockup's "rent", "phone", "transit" and
// "savings" are the API's housing, phone_internet, transport and
// savings_investment.
const ROWS: readonly Row[] = [
  [1, 'Acme Corp Payroll', -199_604, 'income', 'rule', null],
  [1, 'Parkline Apartments', 145_000, 'housing', 'rule', null],
  [2, "Trader Joe's", 8_412, 'groceries', 'rule', null],
  [3, 'PG&E', 6_140, 'utilities', 'rule', null],
  [4, 'Clipper Card Reload', 4_800, 'transport', 'rule', null],
  [5, 'Spotify', 1_199, 'subscriptions', 'rule', null],
  [6, 'Transfer to Chase Savings', 30_000, 'savings_investment', 'rule', null],
  [8, 'Sweetgreen', 1_475, 'dining', 'llm', 0.91],
  [9, 'Amazon', 6_230, 'shopping', 'llm', 0.78],
  [11, 'Blue Bottle Coffee', 625, 'dining', 'user', null],
  [12, 'Verizon Wireless', 7_000, 'phone_internet', 'rule', null],
  [13, 'Costco Wholesale', 14_260, 'shopping', 'llm', 0.62],
  [14, 'Lemonade Renters', 1_200, 'subscriptions', 'llm', 0.71],
  [15, 'Acme Corp Payroll', -199_604, 'income', 'rule', null],
  [16, 'Uber', 1_840, 'transport', 'rule', null],
  [17, "Trader Joe's", 9_133, 'groceries', 'rule', null],
];

const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** Newest first, as `GET /transactions` returns them. */
export const sampleTransactions: readonly Transaction[] = ROWS.map(
  ([day, merchant, cents, category, source, confidence], index) => ({
    id: `7c000000-0000-4000-8000-${pad(index + 1, 12)}`,
    account_id: CHECKING_ID,
    posted_at: `2026-10-${pad(day, 2)}`,
    amount_cents: cents,
    merchant_raw: merchant.toUpperCase(),
    merchant_clean: merchant,
    merchant_norm: merchant
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim(),
    category,
    category_source: source,
    confidence,
    pending: false,
  }),
).reverse();

export function sampleJob(overrides: Partial<Job> = {}): Job {
  return {
    id: '5a000000-0000-4000-8000-000000000001',
    kind: 'sync.initial',
    status: 'queued',
    progress: 0,
    result: null,
    last_error: null,
    created_at: SAMPLE_SYNCED_AT,
    finished_at: null,
    ...overrides,
  };
}
