import type {
  CashFlow,
  CategoryTotal,
  PayStubFlow,
  RecurringCharge,
  SpendingSummary,
  WithholdingLine,
  WithholdingTotal,
} from '@/lib/api/types';
import { SAMPLE_SYNCED_AT } from './sample';

/*
 * What `GET /cashflow`, `GET /spending/summary` and `GET /recurring` return
 * for the sample user (src/test/fixtures/sample.ts): October 1 to 17, the two
 * Acme pay stubs of spec 010 example 2 and the sixteen October transactions.
 * Every total is written out as the API computes it; the client never adds.
 */

export const SAMPLE_PERIOD = { start: '2026-10-01', end: '2026-10-17' } as const;

type LineAmounts = Record<WithholdingLine['key'], number>;

const LINE_INFO: readonly [WithholdingLine['key'], string, WithholdingLine['role']][] = [
  ['federal_withholding', 'Federal tax', 'tax'],
  ['social_security', 'Social Security', 'tax'],
  ['medicare', 'Medicare', 'tax'],
  ['state_tax', 'State tax', 'tax'],
  ['retirement_contribution', '401(k)', 'retirement'],
  ['medical_premium', 'Health premiums', 'health'],
  ['other_deductions', 'Other deductions', 'other'],
];

const lines = (amounts: LineAmounts): WithholdingLine[] =>
  LINE_INFO.map(([key, label, role]) => ({ key, label, role, amount_cents: amounts[key] }));

/** One Acme stub: gross 270,833, net 199,604 (spec 010 example 2). */
const STUB_LINES: LineAmounts = {
  federal_withholding: 29_776,
  social_security: 16_792,
  medicare: 3_927,
  state_tax: 9_814,
  retirement_contribution: 0,
  medical_premium: 6_250,
  other_deductions: 4_670,
};

const stub = (id: string, payDate: string): PayStubFlow => ({
  pay_stub_id: id,
  pay_date: payDate,
  gross_cents: 270_833,
  lines: lines(STUB_LINES),
  roles: { tax_cents: 60_309, retirement_cents: 0, health_cents: 6_250, other_cents: 4_670 },
  deductions_cents: 71_229,
  net_cents: 199_604,
});

/** Both stubs together, as `withholding` sums them. */
const SAMPLE_WITHHOLDING: WithholdingTotal = {
  gross_cents: 541_666,
  lines: lines({
    federal_withholding: 59_552,
    social_security: 33_584,
    medicare: 7_854,
    state_tax: 19_628,
    retirement_contribution: 0,
    medical_premium: 12_500,
    other_deductions: 9_340,
  }),
  roles: { tax_cents: 120_618, retirement_cents: 0, health_cents: 12_500, other_cents: 9_340 },
  deductions_cents: 142_458,
  net_cents: 399_208,
  paycheck_count: 2,
};

const category = (
  name: CategoryTotal['category'],
  bucket: CategoryTotal['bucket'],
  total_cents: number,
  count: number,
): CategoryTotal => ({ category: name, bucket, total_cents, count });

/** `CATEGORY_BUCKETS` in api/sync/categories.py. */
export const CATEGORY_BUCKETS: SpendingSummary['category_buckets'] = {
  income: 'income',
  transfer: 'transfer',
  housing: 'essentials',
  utilities: 'essentials',
  phone_internet: 'essentials',
  groceries: 'essentials',
  dining: 'flexible',
  transport: 'essentials',
  subscriptions: 'flexible',
  insurance: 'essentials',
  healthcare: 'essentials',
  shopping: 'flexible',
  entertainment: 'flexible',
  travel: 'flexible',
  personal_care: 'flexible',
  education: 'flexible',
  gifts_donations: 'flexible',
  fees: 'other',
  taxes: 'other',
  debt_payment: 'other',
  savings_investment: 'savings',
  other: 'other',
};

/** The sixteen October transactions, summarized (categories in the API's category order). */
export const sampleSpendingSummary: SpendingSummary = {
  ...SAMPLE_PERIOD,
  income_cents: 399_208,
  essentials_cents: 182_325,
  flexible_cents: 24_989,
  savings_cents: 30_000,
  other_cents: 0,
  transfers_ignored_cents: 0,
  income_outflows_ignored_cents: 0,
  uncategorized_cents: 0,
  left_over_cents: 161_894,
  essentials_pct: '45.7',
  flexible_pct: '6.3',
  savings_rate_pct: '7.5',
  transaction_count: 16,
  uncategorized_count: 0,
  paycheck_count: 2,
  categories: [
    category('income', 'income', 399_208, 2),
    category('housing', 'essentials', 145_000, 1),
    category('utilities', 'essentials', 6_140, 1),
    category('phone_internet', 'essentials', 7_000, 1),
    category('groceries', 'essentials', 17_545, 2),
    category('dining', 'flexible', 2_100, 2),
    category('transport', 'essentials', 6_640, 2),
    category('subscriptions', 'flexible', 2_399, 2),
    category('shopping', 'flexible', 20_490, 2),
    category('savings_investment', 'savings', 30_000, 1),
  ],
  category_buckets: CATEGORY_BUCKETS,
};

export const PAY_STUB_FLOW_IDS = [
  '6e000000-0000-4000-8000-000000000001',
  '6e000000-0000-4000-8000-000000000015',
] as const;

/** `GET /cashflow` for the sample period. */
export function sampleCashflow(overrides: Partial<CashFlow> = {}): CashFlow {
  return structuredClone({
    ...SAMPLE_PERIOD,
    pay_stubs: [stub(PAY_STUB_FLOW_IDS[0], '2026-10-01'), stub(PAY_STUB_FLOW_IDS[1], '2026-10-15')],
    withholding: SAMPLE_WITHHOLDING,
    spending: sampleSpendingSummary,
    ...overrides,
  });
}

const ZERO_LINES = lines({
  federal_withholding: 0,
  social_security: 0,
  medicare: 0,
  state_tax: 0,
  retirement_contribution: 0,
  medical_premium: 0,
  other_deductions: 0,
});

/** A period with nothing in it: no stubs, no transactions, every amount zero. */
export function emptyCashflow(start: string, end: string): CashFlow {
  return {
    start,
    end,
    pay_stubs: [],
    withholding: {
      gross_cents: 0,
      lines: ZERO_LINES,
      roles: { tax_cents: 0, retirement_cents: 0, health_cents: 0, other_cents: 0 },
      deductions_cents: 0,
      net_cents: 0,
      paycheck_count: 0,
    },
    spending: {
      start,
      end,
      income_cents: 0,
      essentials_cents: 0,
      flexible_cents: 0,
      savings_cents: 0,
      other_cents: 0,
      transfers_ignored_cents: 0,
      income_outflows_ignored_cents: 0,
      uncategorized_cents: 0,
      left_over_cents: 0,
      essentials_pct: null,
      flexible_pct: null,
      savings_rate_pct: null,
      transaction_count: 0,
      uncategorized_count: 0,
      paycheck_count: 0,
      categories: [],
      category_buckets: CATEGORY_BUCKETS,
    },
  };
}

export const SANDBOX_PERIOD = { start: '2026-10-01', end: '2026-10-31' } as const;

/**
 * `GET /cashflow` for October on the Plaid sandbox item with no confirmed
 * stub, as the API returns it (api/tests/integration/test_spending_summary.py,
 * spec 007 rule 22a). The sandbox books its GUSTO PAY payroll as money out,
 * so only 4.22 of interest came in: income 422, the payroll in
 * `income_outflows_ignored_cents`, and spending far beyond the income.
 */
export function sandboxCashflow(): CashFlow {
  const empty = emptyCashflow(SANDBOX_PERIOD.start, SANDBOX_PERIOD.end);
  return {
    ...empty,
    spending: {
      ...empty.spending,
      income_cents: 422,
      essentials_cents: 540,
      flexible_cents: 68_423,
      savings_cents: 100_000,
      other_cents: 0,
      transfers_ignored_cents: 210_350,
      income_outflows_ignored_cents: 585_000,
      uncategorized_cents: 50_000,
      left_over_cents: -168_541,
      essentials_pct: '128.0',
      flexible_pct: '16214.0',
      savings_rate_pct: '23696.7',
      transaction_count: 14,
      uncategorized_count: 1,
      paycheck_count: 0,
      categories: [
        category('income', 'income', 422, 1),
        category('transfer', 'transfer', 210_350, 2),
        category('dining', 'flexible', 51_633, 3),
        category('transport', 'essentials', 540, 1),
        category('shopping', 'flexible', 58_940, 2),
        category('entertainment', 'flexible', 7_850, 1),
        category('travel', 'flexible', -50_000, 1),
        category('savings_investment', 'savings', 100_000, 1),
      ],
    },
  };
}

const charge = (
  id: number,
  merchant: string,
  cents: number,
  status: RecurringCharge['status'],
  firstSeen: string,
  lastSeen: string,
): RecurringCharge => ({
  id: `8d000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
  merchant_norm: merchant
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim(),
  merchant_clean: merchant,
  cadence: 'monthly',
  typical_amount_cents: cents,
  first_seen: firstSeen,
  last_seen: lastSeen,
  status,
  user_status: null,
  updated_at: SAMPLE_SYNCED_AT,
});

/** `GET /recurring`: ordered by name, one charge in each status. */
export const sampleRecurring: readonly RecurringCharge[] = [
  charge(1, 'Hulu', 1_799, 'stopped', '2026-03-09', '2026-08-09'),
  charge(2, 'Lemonade Renters', 1_200, 'new', '2026-08-14', '2026-10-14'),
  charge(3, 'Parkline Apartments', 145_000, 'active', '2026-07-01', '2026-10-01'),
  charge(4, 'Spotify', 1_199, 'active', '2026-06-05', '2026-10-05'),
  charge(5, 'Verizon Wireless', 7_000, 'changed', '2026-06-12', '2026-10-12'),
];
