import type {
  CalculatorKind,
  Decision,
  DecisionList,
  EmergencyFundInput,
  HealthPlansInput,
  K401MatchInput,
  K401MatchResult,
  PayFrequency,
} from './api/types';
import { formatDate } from './dates';
import { deepEqual } from './deep-equal';
import type { CalculatorId } from './features';

/*
 * Saved decisions (spec 007): which calculator is which, and whether what the
 * person has set on a card is the decision they saved. Nothing here computes
 * a result; results come from `POST /calc/*` and are saved as the API
 * recomputes them.
 */

/** The feature flag id of each calculator, to its API name (`calculator_kind`). */
export const CALCULATOR_KINDS = {
  '401k_match': 'k401_match',
  emergency_fund: 'emergency_fund',
  health_plan: 'health_plans',
  w4: 'w4',
} as const satisfies Record<CalculatorId, CalculatorKind>;

const IDS = Object.fromEntries(
  Object.entries(CALCULATOR_KINDS).map(([id, kind]) => [kind, id]),
) as Record<CalculatorKind, CalculatorId>;

export const calculatorIdOf = (kind: CalculatorKind): CalculatorId => IDS[kind];

/** What each calculator's decision is called on a badge or in a list. */
export const CALCULATOR_LABELS: Record<CalculatorKind, string> = {
  emergency_fund: 'Emergency fund',
  k401_match: '401(k) match',
  health_plans: 'Health plan',
  w4: 'W-4, federal only',
};

/** A calculator's current decision from `GET /decisions`, if it has one. */
export function currentDecision(
  list: DecisionList | undefined,
  calculator: CalculatorKind,
): Decision | undefined {
  return list?.items.find((item) => item.calculator === calculator)?.current;
}

type PayPeriods = K401MatchInput['pay_periods_per_year'];

const PAY_PERIODS: Record<PayFrequency, PayPeriods> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
};

/** Paychecks a year for a pay frequency (the calculator's `pay_periods_per_year`). */
export const payPeriodsFor = (frequency: PayFrequency | null | undefined): PayPeriods | null =>
  frequency ? PAY_PERIODS[frequency] : null;

/**
 * The age the 401(k) calculator asks for: the age reached by December 31 of
 * the tax year (spec 006), which is the tax year less the birth year. A
 * difference of years, not money. Null without a birth year, or with one
 * after the tax year (the calculator accepts no negative age).
 */
export function ageAtYearEnd(taxYear: number, birthYear: number | null | undefined): number | null {
  if (birthYear == null || birthYear > taxYear) return null;
  return taxYear - birthYear;
}

/**
 * A whole-number slider value as the API writes a percentage: `4` is
 * `"4.00"`. Sending the stored form keeps a saved decision's inputs and the
 * card's inputs comparable as they are.
 */
export const percentInput = (whole: number): string => whole.toFixed(2);

export interface DecisionSaveState {
  /** unsaved: no decision yet. dirty: the inputs differ from the current version. */
  status: 'unsaved' | 'dirty' | 'saved';
  /** The current version, or null before the first save. */
  version: number | null;
  /** The save button's words. */
  action: string;
  /** The card badge's words. */
  label: string;
}

/**
 * Whether the inputs on a card are the calculator's current decision. The
 * comparison is structural and exact: the API stores canonical inputs
 * (integer cents, two-place percentage strings) and the cards send them in
 * that form, so equal means the same decision.
 */
export function decisionSaveState(
  current: Decision | null | undefined,
  inputs: unknown,
): DecisionSaveState {
  if (!current) {
    return { status: 'unsaved', version: null, action: 'Save this decision', label: 'Not saved' };
  }
  const { version } = current;
  if (inputs !== null && deepEqual(current.inputs, inputs)) {
    return {
      status: 'saved',
      version,
      action: `Saved as v${version}`,
      label: `Saved v${version} · ${formatDate(current.created_at, 'short')}`,
    };
  }
  return {
    status: 'dirty',
    version,
    action: `Save as v${version + 1}`,
    label: `Changed since v${version}`,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isInt = (value: unknown) => Number.isSafeInteger(value);
const isText = (value: unknown) => typeof value === 'string';

const isTier = (value: unknown) =>
  isRecord(value) && isText(value.employee_pct_upto) && isText(value.employer_pct);

/** A saved `k401_match` decision's inputs, or null when they are not that shape. */
export function asK401Inputs(inputs: Record<string, unknown>): K401MatchInput | null {
  const ok =
    isInt(inputs.salary_cents) &&
    isInt(inputs.pay_periods_per_year) &&
    Array.isArray(inputs.match_tiers) &&
    inputs.match_tiers.every(isTier) &&
    isText(inputs.contribution_pct) &&
    isInt(inputs.tax_year) &&
    isText(inputs.filing_status) &&
    isInt(inputs.age);
  return ok ? (inputs as unknown as K401MatchInput) : null;
}

/** A saved `emergency_fund` decision's inputs, or null when they are not that shape. */
export function asEmergencyFundInputs(inputs: Record<string, unknown>): EmergencyFundInput | null {
  const ok = (
    [
      'monthly_essentials_cents',
      'target_months',
      'current_balance_cents',
      'monthly_contribution_cents',
      'pay_periods_per_year',
    ] as const
  ).every((key) => isInt(inputs[key]));
  return ok ? (inputs as unknown as EmergencyFundInput) : null;
}

const PLAN_KINDS = new Set(['hdhp', 'ppo', 'hmo']);
const USAGES = new Set(['low', 'medium', 'high']);

const isPlanOption = (value: unknown) =>
  isRecord(value) &&
  isText(value.name) &&
  PLAN_KINDS.has(value.kind as string) &&
  isInt(value.premium_per_period_cents) &&
  isInt(value.deductible_cents) &&
  isText(value.coinsurance_pct) &&
  isInt(value.oop_max_cents) &&
  isInt(value.employer_hsa_cents);

/** A saved `health_plans` decision's inputs, or null when they are not that shape. */
export function asHealthPlansInputs(inputs: Record<string, unknown>): HealthPlansInput | null {
  const ok =
    Array.isArray(inputs.plans) &&
    inputs.plans.length > 0 &&
    inputs.plans.every(isPlanOption) &&
    isInt(inputs.pay_periods_per_year) &&
    isInt(inputs.salary_cents) &&
    isText(inputs.filing_status) &&
    isInt(inputs.tax_year) &&
    isInt(inputs.employee_hsa_cents) &&
    USAGES.has(inputs.expected_usage as string) &&
    (inputs.selected_plan_index === null || isInt(inputs.selected_plan_index)) &&
    (inputs.enrollment_deadline === null || isText(inputs.enrollment_deadline));
  return ok ? (inputs as unknown as HealthPlansInput) : null;
}

const RESULT_CENTS = [
  'employer_match_cents_current',
  'employer_match_cents_full',
  'missed_cents',
  'employee_annual_cents_current',
  'employee_annual_cents_full',
  'per_paycheck_cost_delta_cents',
  'per_paycheck_after_tax_cost_cents',
  'deferral_limit_cents',
] as const satisfies readonly (keyof K401MatchResult)[];

/** A saved `k401_match` decision's result, or null when it is not that shape. */
export function asK401Result(result: Record<string, unknown>): K401MatchResult | null {
  const ok =
    RESULT_CENTS.every((key) => isInt(result[key])) &&
    isText(result.full_match_pct) &&
    isText(result.marginal_rate_used) &&
    typeof result.capped === 'boolean' &&
    typeof result.compensation_capped === 'boolean' &&
    Array.isArray(result.citation_keys);
  return ok ? (result as unknown as K401MatchResult) : null;
}
