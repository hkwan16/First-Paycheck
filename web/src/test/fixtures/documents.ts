import type {
  DocumentDetail,
  DocumentStatusReason,
  DocumentSummary,
  PayStub,
  PayStubValues,
  Profile,
  Proposal,
  ProposedField,
  SourceLine,
} from '@/lib/api/types';
import { SAMPLE_SYNCED_AT } from './sample';

/*
 * The Confirm mockup's pay stub (docs/mockup/Confirm.dc.html) in the API's
 * shapes: the fields `api/ingest/proposal.py` proposes, in its order, with its
 * labels, kinds and roles. The mockup's CA SDI and dental and vision lines
 * have no column of their own, so the API sums them into "Other deductions"
 * (spec 005 rule 3, hand-worked example row 1). Invented data only.
 */

export const PAY_STUB_DOC_ID = '4d000000-0000-4000-8000-000000000001';
export const BENEFITS_DOC_ID = '4d000000-0000-4000-8000-000000000002';

/** When the sample pay stub was uploaded: two minutes before SAMPLE_NOW. */
export const SAMPLE_UPLOADED_AT = '2026-10-17T15:58:00Z';

type Row = [
  key: string,
  label: string,
  kind: ProposedField['kind'],
  role: ProposedField['role'],
  value: ProposedField['value'],
  confidence: number | null,
  note?: string,
];

const ROWS: readonly Row[] = [
  ['employer_name', 'Employer', 'text', 'info', 'Acme Corp', 0.99],
  ['pay_date', 'Pay date', 'date', 'info', '2026-10-15', 0.98],
  ['period_start', 'Period start', 'date', 'info', '2026-10-01', 0.97],
  ['period_end', 'Period end', 'date', 'info', '2026-10-15', 0.97],
  ['pay_frequency', 'Pay frequency', 'text', 'info', 'semimonthly', 0.95],
  ['gross_cents', 'Gross pay', 'money', 'gross', 270_833, 0.99],
  ['federal_withholding_cents', 'Federal income tax', 'money', 'deduction', 29_776, 0.96],
  ['social_security_cents', 'Social Security', 'money', 'deduction', 16_792, 0.99],
  ['medicare_cents', 'Medicare', 'money', 'deduction', 3_927, 0.99],
  ['state_tax_cents', 'State income tax', 'money', 'deduction', 9_814, 0.91],
  ['retirement_contribution_cents', '401(k) contribution', 'money', 'deduction', 0, 0.74],
  ['medical_premium_cents', 'Medical premium', 'money', 'deduction', 6_250, 0.88],
  [
    'other_deductions_cents',
    'Other deductions',
    'money',
    'deduction',
    4_670,
    null,
    'Sum of: CA SDI, DENTAL/VIS',
  ],
  ['net_cents', 'Net pay', 'money', 'net', 199_604, 0.99],
];

export const sampleFields: readonly ProposedField[] = ROWS.map(
  ([key, label, kind, role, value, confidence, note]) => ({
    key,
    label,
    kind,
    role,
    value,
    confidence,
    note: note ?? null,
  }),
);

const line = (text: string, fieldKey: string | null = null): SourceLine => ({
  page: 1,
  text,
  field_key: fieldKey,
  redacted: text.includes('[REDACTED]'),
});

/** The redacted lines the model read, each linked to the field it supports. */
export const sampleSourceLines: readonly SourceLine[] = [
  line('ACME CORP EARNINGS STATEMENT', 'employer_name'),
  line('EMPLOYEE RIVERA, J'),
  line('SSN [REDACTED]'),
  line('DEPOSIT ACCT [REDACTED]4821'),
  line('PAY FREQ SEMI-MONTHLY', 'pay_frequency'),
  line('PAY DATE 10/15/2026', 'pay_date'),
  line('PERIOD 10/01/2026 - 10/15/2026', 'period_start'),
  line('GROSS PAY 2,708.33', 'gross_cents'),
  line('FED W/H 297.76', 'federal_withholding_cents'),
  line('OASDI 167.92', 'social_security_cents'),
  line('MEDICARE 39.27', 'medicare_cents'),
  line('CA W/H 98.14', 'state_tax_cents'),
  line('CA SDI 32.50'),
  line('401K EE -', 'retirement_contribution_cents'),
  line('MED PRETAX 62.50', 'medical_premium_cents'),
  line('DENTAL/VIS 14.20'),
  line('NET PAY 1,996.04', 'net_cents'),
  line('YTD GROSS 5,416.66'),
];

export const sampleProposal: Proposal = {
  kind: 'pay_stub',
  fields: [...sampleFields],
  line_items: [
    { label: 'GROSS PAY', amount_cents: 270_833, kind: 'earning', field: 'gross_cents' },
    { label: 'FED W/H', amount_cents: 29_776, kind: 'tax', field: 'federal_withholding_cents' },
    { label: 'OASDI', amount_cents: 16_792, kind: 'tax', field: 'social_security_cents' },
    { label: 'MEDICARE', amount_cents: 3_927, kind: 'tax', field: 'medicare_cents' },
    { label: 'CA W/H', amount_cents: 9_814, kind: 'tax', field: 'state_tax_cents' },
    { label: 'CA SDI', amount_cents: 3_250, kind: 'tax', field: null },
    {
      label: 'MED PRETAX',
      amount_cents: 6_250,
      kind: 'pre_tax_deduction',
      field: 'medical_premium_cents',
    },
    { label: 'DENTAL/VIS', amount_cents: 1_420, kind: 'pre_tax_deduction', field: null },
    { label: 'NET PAY', amount_cents: 199_604, kind: 'net', field: 'net_cents' },
    { label: 'YTD GROSS', amount_cents: 541_666, kind: 'info', field: null },
  ],
  plans: [],
  source_lines: [...sampleSourceLines],
  withheld_pages: [],
  notes: null,
};

/** What `manual_entry_proposal` returns: every field empty, the redacted lines to type from. */
export const manualEntryProposal: Proposal = {
  kind: 'pay_stub',
  fields: sampleFields.map((f) => ({ ...f, value: null, confidence: null, note: null })),
  line_items: [],
  plans: [],
  source_lines: sampleSourceLines.map((l) => ({ ...l, field_key: null })),
  withheld_pages: [],
  notes: null,
};

/** Reasons the reading was unavailable, which the API reads again (spec 004 rule 32). */
const READ_AGAIN_REASONS: ReadonlySet<DocumentStatusReason> = new Set([
  'no_model',
  'budget',
  'extraction_failed',
]);

/**
 * `can_read_again` as `api/app/routers/docs.py:can_read_again` works it out
 * (spec 004 rule 33), so the test API and the samples answer like the real one.
 */
export function canReadAgain(document: Omit<DocumentSummary, 'can_read_again'>): boolean {
  return (
    document.status === 'manual_entry_required' &&
    document.status_reason !== null &&
    READ_AGAIN_REASONS.has(document.status_reason) &&
    document.type !== 'offer_letter' &&
    document.replaced_by_id === null &&
    document.deleted_at === null
  );
}

export function sampleDocument(overrides: Partial<DocumentSummary> = {}): DocumentSummary {
  const document: Omit<DocumentSummary, 'can_read_again'> = {
    id: PAY_STUB_DOC_ID,
    type: 'pay_stub',
    status: 'proposed',
    status_reason: null,
    redaction_count: 2,
    page_count: 1,
    uploaded_at: SAMPLE_UPLOADED_AT,
    confirmed_at: null,
    deleted_at: null,
    replaced_by_id: null,
    ...overrides,
  };
  return { ...document, can_read_again: overrides.can_read_again ?? canReadAgain(document) };
}

export function sampleDocumentDetail(
  overrides: Partial<DocumentDetail> = {},
  proposal: Proposal | null = sampleProposal,
): DocumentDetail {
  return { ...sampleDocument(overrides), proposal, ...overrides };
}

/** The benefits summary the Link mockup lists below the pay stub (uploaded just before it). */
export const sampleBenefitsDocument = sampleDocument({
  id: BENEFITS_DOC_ID,
  type: 'benefits',
  redaction_count: 0,
  page_count: 14,
  uploaded_at: '2026-10-17T15:57:00Z',
});

/** The sample stub's values as the Confirm screen sends them. */
export const sampleValues: PayStubValues = {
  employer_name: 'Acme Corp',
  pay_date: '2026-10-15',
  period_start: '2026-10-01',
  period_end: '2026-10-15',
  pay_frequency: 'semimonthly',
  gross_cents: 270_833,
  federal_withholding_cents: 29_776,
  social_security_cents: 16_792,
  medicare_cents: 3_927,
  state_tax_cents: 9_814,
  retirement_contribution_cents: 0,
  medical_premium_cents: 6_250,
  other_deductions_cents: 4_670,
  net_cents: 199_604,
};

/**
 * What the API reports as the sample stub's yearly salary (spec 005 rule 24a,
 * row 1: `calc/pay_stub.py:annual_salary_cents`), copied, never computed here.
 */
export const SAMPLE_ANNUAL_SALARY_CENTS = 6_499_992;

/**
 * What the API reports as the sample stub's 401(k) rate (spec 005 rule 24b,
 * row 4: no retirement line is 0.00), copied, never computed here.
 */
export const SAMPLE_RETIREMENT_CONTRIBUTION_PCT = '0.00';

export function samplePayStub(overrides: Partial<PayStub> = {}): PayStub {
  return {
    id: '6e000000-0000-4000-8000-000000000001',
    document_id: PAY_STUB_DOC_ID,
    tax_year: 2026,
    created_at: SAMPLE_SYNCED_AT,
    ...sampleValues,
    annual_salary_cents: SAMPLE_ANNUAL_SALARY_CENTS,
    retirement_contribution_pct: SAMPLE_RETIREMENT_CONTRIBUTION_PCT,
    ...overrides,
  };
}

/**
 * The synthetic stub of issue 132 (evals/fixtures/pay_stubs/stub-01.pdf) as the
 * API returns it once confirmed: $109.62 of a $3,653.85 biweekly paycheck goes
 * to the 401(k). Its yearly salary (365,385 x 26) and its rate, 3.00 (spec 005
 * rule 24b, row 1), are the API's figures, copied.
 */
export function stub01PayStub(overrides: Partial<PayStub> = {}): PayStub {
  return {
    id: '6e000000-0000-4000-8000-000000000132',
    document_id: PAY_STUB_DOC_ID,
    employer_name: 'Acme Corp',
    pay_date: '2026-04-10',
    period_start: '2026-03-23',
    period_end: '2026-04-05',
    pay_frequency: 'biweekly',
    tax_year: 2026,
    gross_cents: 365_385,
    federal_withholding_cents: 27_244,
    social_security_cents: 22_654,
    medicare_cents: 5_298,
    state_tax_cents: 16_442,
    retirement_contribution_cents: 10_962,
    medical_premium_cents: 2_500,
    other_deductions_cents: 5_199,
    net_cents: 275_086,
    created_at: SAMPLE_SYNCED_AT,
    annual_salary_cents: 9_500_010,
    retirement_contribution_pct: '3.00',
    ...overrides,
  };
}

/** `GET /profile` for a user who has saved nothing. */
export const emptyProfile: Profile = {
  birth_year: null,
  dependents: 0,
  expected_healthcare_usage: null,
  filing_status: null,
  match_tiers: [],
  other_jobs: [],
  pay_frequency: null,
  salary_cents: null,
  start_date: null,
  updated_at: null,
  vesting_years: null,
};
