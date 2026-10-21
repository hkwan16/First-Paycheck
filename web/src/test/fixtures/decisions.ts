import type {
  CalendarEvent,
  Citation,
  Decision,
  Explanation,
  K401MatchInput,
  K401MatchResult,
  Profile,
} from '@/lib/api/types';
import { deepEqual } from '@/lib/deep-equal';
import { emptyProfile } from './documents';
import cases from './k401-results.json';

/*
 * Decisions, explanations and calendar events for the mockup's sample user
 * (J. Rivera, Acme Corp, $65,000.00, semi-monthly, a 100% match up to 4%).
 * Every 401(k) result here was computed by the API's calculator
 * (k401-results.json, written by make-k401-results.py); nothing is worked out
 * in TypeScript. Invented data only.
 */

export interface K401Case {
  inputs: K401MatchInput;
  result: K401MatchResult;
}

export const k401Cases = cases as unknown as readonly K401Case[];

/** The API's result for these inputs, if k401-results.json has the case. */
export function k401Result(inputs: unknown): K401MatchResult | undefined {
  return k401Cases.find((c) => deepEqual(c.inputs, inputs))?.result;
}

function knownCase(inputs: K401MatchInput): K401Case {
  const result = k401Result(inputs);
  if (!result) throw new Error(`k401-results.json has no case for ${JSON.stringify(inputs)}`);
  return { inputs, result };
}

/** The sample's calculator inputs at a whole contribution percentage (0 to 15). */
export function sampleK401Inputs(contributionPct = 0): K401MatchInput {
  return {
    salary_cents: 6_500_000,
    pay_periods_per_year: 24,
    match_tiers: [{ employee_pct_upto: '4.00', employer_pct: '100.00' }],
    contribution_pct: `${contributionPct}.00`,
    tax_year: 2026,
    filing_status: 'single',
    age: 30,
  };
}

/** The sample at a contribution percentage, with the API's result. */
export const sampleK401 = (contributionPct = 0) => knownCase(sampleK401Inputs(contributionPct));

/** Spec 006 example 9: $500,000.00 at 6%, over both the 402(g) and compensation limits. */
export const cappedK401: K401Case = knownCase({
  salary_cents: 50_000_000,
  pay_periods_per_year: 26,
  match_tiers: [
    { employee_pct_upto: '3.00', employer_pct: '100.00' },
    { employee_pct_upto: '5.00', employer_pct: '50.00' },
  ],
  contribution_pct: '6.00',
  tax_year: 2026,
  filing_status: 'single',
  age: 30,
});

/** `GET /profile` for the sample user, with the plan details the 401(k) card needs. */
export const sampleProfile: Profile = {
  ...emptyProfile,
  salary_cents: 6_500_000,
  pay_frequency: 'semimonthly',
  filing_status: 'single',
  match_tiers: [{ employee_pct_upto: '4.00', employer_pct: '100.00' }],
  updated_at: '2026-10-17T15:58:30Z',
};

export const DECISION_V1_ID = 'dec00000-0000-4000-8000-000000000001';

/** When the sample decision was saved: just before the sample clock. */
export const SAMPLE_SAVED_AT = '2026-10-17T15:59:00Z';

/** The sample's 401(k) decision: version 1, contributing 4% (the full match). */
export function sampleDecision(overrides: Partial<Decision> = {}): Decision {
  const { inputs, result } = sampleK401(4);
  return {
    id: DECISION_V1_ID,
    calculator: 'k401_match',
    version: 1,
    supersedes_id: null,
    check_in_id: null,
    inputs: { ...inputs },
    result: { ...result },
    created_at: SAMPLE_SAVED_AT,
    is_current: true,
    ...overrides,
  };
}

/** The curated IRS passages (api/db/seed/irs_citations/k401.yaml) the sample cites. */
export const sampleCitations: readonly Citation[] = [
  {
    key: 'k401.employer_match',
    title: 'Matching contributions help you save more for retirement',
    url: 'https://www.irs.gov/retirement-plans/matching-contributions-help-you-save-more-for-retirement',
    passage:
      'Many retirement plans, such as SIMPLE IRAs and 401(k)s, provide that your employer will match some portion of the amount you contribute to your retirement account. ... Generally, the more you contribute to the plan, up to the plan’s match limit, the more you receive in matching contributions.',
    source: 'IRS, Retirement Plans',
  },
  {
    key: 'k401.pretax_deferral',
    title: 'How 401(k) elective deferrals are taxed',
    url: 'https://www.irs.gov/retirement-plans/plan-participant-employee/401k-resource-guide-plan-participants-401k-plan-overview',
    passage:
      'These deferred wages (elective deferrals) are generally not subject to federal income tax withholding at the time of deferral ... Although elective deferrals are not treated as current income for federal income tax purposes, they are included as wages subject to Social Security (FICA), Medicare, and federal unemployment taxes (FUTA).',
    source: 'IRS 401(k) Resource Guide, Plan Participants',
  },
  {
    key: 'k401.deferral_limit',
    title: '2026 limit on 401(k) elective deferrals',
    url: 'https://www.irs.gov/pub/irs-drop/n-25-67.pdf',
    passage:
      'The limitation under section 402(g)(1) on the exclusion for elective deferrals described in section 402(g)(3), which includes elective deferrals made to the Thrift Savings Plan, is increased from $23,500 to $24,500.',
    source: 'IRS Notice 2025-67',
  },
];

export const EXPLANATION_ID = 'e0000000-0000-4000-8000-000000000001';

/** A verified explanation of the sample decision, as the API returns it. */
export function sampleExplanation(overrides: Partial<Explanation> = {}): Explanation {
  return {
    id: EXPLANATION_ID,
    decision_id: DECISION_V1_ID,
    concept:
      'An employer match is pay you receive only when you contribute, and 4% of your salary earns all of it.',
    text: [
      'Acme adds a dollar for every dollar you put in, up to 4% of your salary. At 4% you put in $2,600 a year and Acme adds $2,600, the full match.',
      'Contributions come out before federal income tax, so each dollar you defer lowers your taxable wages at your 12% marginal rate. In 2026 you can defer up to $24,500 in total, well above your $2,600.',
    ].join('\n\n'),
    numbers: [
      { value: '$65,000', label: 'Salary' },
      { value: '$2,600', label: 'You put in per year' },
      { value: '$2,600', label: "Acme's match per year" },
      { value: '12%', label: 'Your marginal rate' },
      { value: '$24,500', label: '2026 limit on your contributions' },
    ],
    what_ifs: [
      'Contributing less than 4% gives part of the match back to Acme.',
      'A different match formula would change the percentage that earns the full match.',
      'Leaving before the match vests can make it worth less than it looks.',
    ],
    citations: [...sampleCitations],
    verified: true,
    fallback: false,
    attempt: 1,
    retries: 0,
    prompt_version: 'explain/v1',
    verification: {
      numbers_checked: 12,
      numbers_unmatched: [],
      citations_checked: 3,
      citations_unknown: [],
      has_citation: true,
    },
    created_at: '2026-10-17T15:59:30Z',
    ...overrides,
  };
}

/**
 * The fallback row that follows two drafts that failed verification: the
 * plain calculator result written by code (api/verify/fallback.py).
 */
export function sampleFallbackExplanation(overrides: Partial<Explanation> = {}): Explanation {
  return sampleExplanation({
    id: 'e0000000-0000-4000-8000-000000000003',
    concept: "Your employer's 401(k) match and what it costs you to earn all of it.",
    text: 'At 4% of pay you put in $2,600.00 a year and your employer adds $2,600.00. You already earn the full match of $2,600.00 a year. Your 2026 limit on 401(k) contributions is $24,500.00.',
    numbers: [
      { value: '$2,600.00', label: 'Your yearly contribution' },
      { value: '$2,600.00', label: 'Full employer match per year' },
    ],
    what_ifs: [],
    verified: false,
    fallback: true,
    attempt: 3,
    retries: 1,
    prompt_version: 'fallback/v1',
    verification: {
      numbers_checked: 5,
      numbers_unmatched: [],
      citations_checked: 3,
      citations_unknown: [],
      has_citation: true,
    },
    ...overrides,
  });
}

/** The check a saved 401(k) decision schedules for the next pay date. */
export function sampleCalendarEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'ca000000-0000-4000-8000-000000000001',
    kind: 'election_check',
    title: 'Check that your next pay stub shows your new 401(k) contribution',
    due_at: '2026-10-31',
    decision_id: DECISION_V1_ID,
    status: 'upcoming',
    ...overrides,
  };
}
