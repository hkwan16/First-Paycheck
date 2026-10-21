import type {
  BenefitsPlan,
  CalendarEvent,
  Decision,
  EmergencyFundInput,
  EmergencyFundResult,
  Goal,
  HealthPlanOption,
  HealthPlansInput,
  HealthPlansResult,
  Proposal,
  ProposedField,
  SourceLine,
} from '@/lib/api/types';
import { deepEqual } from '@/lib/deep-equal';
import { SAMPLE_SAVED_AT } from './decisions';
import { BENEFITS_DOC_ID } from './documents';
import efCases from './emergency-fund-results.json';
import hpCases from './health-plans-results.json';
import { SAVINGS_ID } from './sample';

/*
 * The M6 sample: J. Rivera's emergency fund (essentials of $1,823.25 a month
 * from the sample spending summary, $2,140.00 in Chase Savings) and Acme's two
 * medical plans from the benefits summary the Link mockup lists. Every
 * calculator result here was computed by the API's own calculators
 * (emergency-fund-results.json and health-plans-results.json, written by
 * make-emergency-fund-results.py and make-health-plans-results.py); nothing
 * is worked out in TypeScript. Invented data only.
 */

interface Case<I, R> {
  inputs: I;
  result: R;
}

export type EmergencyFundCase = Case<EmergencyFundInput, EmergencyFundResult>;
export type HealthPlansCase = Case<HealthPlansInput, HealthPlansResult>;

export const emergencyFundCases = efCases as unknown as readonly EmergencyFundCase[];
export const healthPlansCases = hpCases as unknown as readonly HealthPlansCase[];

/** The API's emergency fund result for these inputs, if the fixture has the case. */
export const emergencyFundResult = (inputs: unknown) =>
  emergencyFundCases.find((c) => deepEqual(c.inputs, inputs))?.result;

/** The API's health plan comparison for these inputs, if the fixture has the case. */
export const healthPlansResult = (inputs: unknown) =>
  healthPlansCases.find((c) => deepEqual(c.inputs, inputs))?.result;

function known<I, R>(inputs: I, find: (inputs: unknown) => R | undefined, file: string) {
  const result = find(inputs);
  if (!result) throw new Error(`${file} has no case for ${JSON.stringify(inputs)}`);
  return { inputs, result };
}

/** The sample's emergency fund inputs: essentials and savings from the sample data. */
export function sampleEmergencyFundInputs(
  overrides: Partial<EmergencyFundInput> = {},
): EmergencyFundInput {
  return {
    monthly_essentials_cents: 182_325,
    target_months: 3,
    current_balance_cents: 214_000,
    monthly_contribution_cents: 30_000,
    pay_periods_per_year: 24,
    ...overrides,
  };
}

/** The sample at these inputs, with the API's result. */
export const sampleEmergencyFund = (overrides: Partial<EmergencyFundInput> = {}) =>
  known(sampleEmergencyFundInputs(overrides), emergencyFundResult, 'emergency-fund-results.json');

/** Acme's high-deductible plan, as the calculator takes it. */
export const BRONZE_HSA: HealthPlanOption = {
  name: 'Bronze HSA',
  kind: 'hdhp',
  premium_per_period_cents: 3_125,
  deductible_cents: 180_000,
  coinsurance_pct: '20.00',
  oop_max_cents: 350_000,
  employer_hsa_cents: 60_000,
};

export const GOLD_PPO: HealthPlanOption = {
  name: 'Gold PPO',
  kind: 'ppo',
  premium_per_period_cents: 6_250,
  deductible_cents: 25_000,
  coinsurance_pct: '10.00',
  oop_max_cents: 300_000,
  employer_hsa_cents: 0,
};

/** A plan typed by hand on the health plan card (no benefits summary confirmed). */
export const SILVER_HMO: HealthPlanOption = {
  name: 'Silver HMO',
  kind: 'hmo',
  premium_per_period_cents: 4_000,
  deductible_cents: 100_000,
  coinsurance_pct: '0.00',
  oop_max_cents: 250_000,
  employer_hsa_cents: 0,
};

/** The enrollment deadline the sample benefits summary prints. */
export const ENROLLMENT_DEADLINE = '2026-11-14';

/** The sample's health plan inputs: both Acme plans, medium usage, nothing chosen yet. */
export function sampleHealthPlansInputs(
  overrides: Partial<HealthPlansInput> = {},
): HealthPlansInput {
  return {
    plans: [{ ...BRONZE_HSA }, { ...GOLD_PPO }],
    pay_periods_per_year: 24,
    salary_cents: 6_500_000,
    filing_status: 'single',
    tax_year: 2026,
    employee_hsa_cents: 0,
    expected_usage: 'medium',
    usage_low_cents: 50_000,
    usage_medium_cents: 300_000,
    usage_high_cents: 1_000_000,
    selected_plan_index: null,
    enrollment_deadline: ENROLLMENT_DEADLINE,
    ...overrides,
  };
}

export const sampleHealthPlans = (overrides: Partial<HealthPlansInput> = {}) =>
  known(sampleHealthPlansInputs(overrides), healthPlansResult, 'health-plans-results.json');

/** `GET /benefits-plans` after the sample benefits summary is confirmed. */
export const sampleBenefitsPlans: readonly BenefitsPlan[] = [BRONZE_HSA, GOLD_PPO].map(
  (plan, index) => ({
    ...plan,
    coinsurance_pct: String(plan.coinsurance_pct),
    id: `be000000-0000-4000-8000-00000000000${index + 1}`,
    document_id: BENEFITS_DOC_ID,
    enrollment_deadline: ENROLLMENT_DEADLINE,
    created_at: SAMPLE_SAVED_AT,
  }),
);

export const EMERGENCY_DECISION_ID = 'dec00000-0000-4000-8000-0000000000e1';
export const HEALTH_DECISION_ID = 'dec00000-0000-4000-8000-0000000000c1';
export const GOAL_ID = 'a0a10000-0000-4000-8000-000000000001';

/** The sample's emergency fund decision: three months, $300 a month. */
export function sampleEmergencyDecision(overrides: Partial<Decision> = {}): Decision {
  const { inputs, result } = sampleEmergencyFund();
  return {
    id: EMERGENCY_DECISION_ID,
    calculator: 'emergency_fund',
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

/** The sample's health plan decision: the Gold PPO, at medium usage. */
export function sampleHealthDecision(overrides: Partial<Decision> = {}): Decision {
  const { inputs, result } = sampleHealthPlans({ selected_plan_index: 1 });
  return {
    id: HEALTH_DECISION_ID,
    calculator: 'health_plans',
    version: 1,
    supersedes_id: null,
    check_in_id: null,
    inputs: structuredClone(inputs),
    result: structuredClone(result),
    created_at: SAMPLE_SAVED_AT,
    is_current: true,
    ...overrides,
  };
}

/**
 * The goal the sample emergency fund decision creates: linked to Chase
 * Savings, reached twelve contributions after the first on Oct 31, 2026
 * (spec 011 rule 11).
 */
export function sampleGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: GOAL_ID,
    kind: 'emergency_fund',
    status: 'active',
    target_amount_cents: 546_975,
    monthly_contribution_cents: 30_000,
    account_id: SAVINGS_ID,
    decision_id: EMERGENCY_DECISION_ID,
    target_date: '2027-09-30',
    reached_at: null,
    current_balance_cents: 214_000,
    progress_pct: '39.12',
    created_at: SAMPLE_SAVED_AT,
    updated_at: SAMPLE_SAVED_AT,
    ...overrides,
  };
}

/** The calendar events saving the sample decisions adds. */
export function samplePlanningEvents(): CalendarEvent[] {
  return [
    {
      id: 'ca000000-0000-4000-8000-0000000000e1',
      kind: 'goal_contribution',
      title: 'Make your first emergency fund contribution',
      due_at: '2026-10-31',
      decision_id: EMERGENCY_DECISION_ID,
      status: 'upcoming',
    },
    {
      id: 'ca000000-0000-4000-8000-0000000000c1',
      kind: 'enrollment_deadline',
      title: 'Health plan enrollment deadline',
      due_at: ENROLLMENT_DEADLINE,
      decision_id: HEALTH_DECISION_ID,
      status: 'upcoming',
    },
    {
      id: 'ca000000-0000-4000-8000-0000000000e2',
      kind: 'goal_review',
      title: 'Review your emergency fund progress',
      due_at: '2027-01-31',
      decision_id: EMERGENCY_DECISION_ID,
      status: 'upcoming',
    },
  ];
}

type FieldRow = [
  key: string,
  label: string,
  kind: ProposedField['kind'],
  value: ProposedField['value'],
  confidence: number | null,
  note?: string,
];

const field = ([key, label, kind, value, confidence, note]: FieldRow): ProposedField => ({
  key,
  label,
  kind,
  role: 'info',
  value,
  confidence,
  note: note ?? null,
});

/** One plan's fields in `api/ingest/proposal.py` PLAN_FIELDS order, with its labels. */
const planFields = (plan: HealthPlanOption, confidences: readonly number[]) =>
  (
    [
      ['name', 'Plan name', 'text', plan.name],
      ['kind', 'Plan type', 'text', plan.kind],
      ['premium_per_period_cents', 'Premium per paycheck', 'money', plan.premium_per_period_cents],
      ['deductible_cents', 'Deductible', 'money', plan.deductible_cents],
      ['oop_max_cents', 'Out-of-pocket maximum', 'money', plan.oop_max_cents],
      ['coinsurance_pct', 'Coinsurance', 'percent', String(plan.coinsurance_pct)],
      ['employer_hsa_cents', 'Employer HSA contribution', 'money', plan.employer_hsa_cents],
      ['enrollment_deadline', 'Enrollment deadline', 'date', ENROLLMENT_DEADLINE],
    ] as const
  ).map(([key, label, kind, value], index) =>
    field([key, label, kind, value, confidences[index] ?? 0.95]),
  );

const sourceLine = (text: string): SourceLine => ({
  page: 1,
  text,
  field_key: null,
  redacted: text.includes('[REDACTED]'),
});

/**
 * The sample benefits summary as the API proposes it (spec 013 rule 8): two
 * plans, the match tiers 100% of the first 3% and 50% of the next 2% (bounds
 * computed in code, so the second carries the "Cumulative" note) and a
 * three-year vesting schedule. Benefits lines are not linked to fields.
 */
export const sampleBenefitsProposal: Proposal = {
  kind: 'benefits',
  fields: [],
  line_items: [],
  plans: [
    { fields: planFields(BRONZE_HSA, [0.97, 0.95, 0.96, 0.94, 0.93, 0.92, 0.86, 0.9]) },
    { fields: planFields(GOLD_PPO, [0.97, 0.96, 0.96, 0.95, 0.94, 0.82, 0.99, 0.9]) },
  ],
  match_tiers: [
    {
      fields: [
        field(['employee_pct_upto', 'Matched up to (% of pay)', 'percent', '3.00', 0.9]),
        field(['employer_pct', 'Employer match', 'percent', '100.00', 0.95]),
      ],
    },
    {
      fields: [
        field([
          'employee_pct_upto',
          'Matched up to (% of pay)',
          'percent',
          '5.00',
          0.8,
          'Cumulative: 2.00% added to the tiers before it',
        ]),
        field(['employer_pct', 'Employer match', 'percent', '50.00', 0.92]),
      ],
    },
  ],
  vesting_years: field(['vesting_years', 'Years to full vesting', 'number', 3, 0.88]),
  source_lines: [
    'ACME CORP 2027 BENEFITS SUMMARY',
    'EMPLOYEE RIVERA, J   MEMBER ID [REDACTED]',
    'MEDICAL PLANS, EMPLOYEE-ONLY COVERAGE',
    'BRONZE HSA (HIGH DEDUCTIBLE)',
    'PREMIUM PER PAYCHECK 31.25',
    'DEDUCTIBLE 1,800.00',
    'COINSURANCE AFTER DEDUCTIBLE 20%',
    'OUT-OF-POCKET MAXIMUM 3,500.00',
    'ACME HSA CONTRIBUTION 600.00',
    'GOLD PPO',
    'PREMIUM PER PAYCHECK 62.50',
    'DEDUCTIBLE 250.00',
    'COINSURANCE AFTER DEDUCTIBLE 10%',
    'OUT-OF-POCKET MAXIMUM 3,000.00',
    'ENROLL BY 11/14/2026',
    '401(K) ACME MATCHES 100% OF THE FIRST 3% AND 50% OF THE NEXT 2%',
    'VESTING 3-YEAR CLIFF',
  ].map(sourceLine),
  withheld_pages: [],
  notes: null,
};
