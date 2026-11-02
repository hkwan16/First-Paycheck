import type { Decision, W4Input, W4Result } from '@/lib/api/types';
import { asHealthPlansInputs, asK401Inputs } from '@/lib/decisions';
import type { Tone } from '@/lib/design/tone';
import { formatMoney, formatRate } from '@/lib/money';
import type { ReadAmount } from './decision-format';

/*
 * The W-4 card's words. Every amount here is a field the calculator returned
 * or one the person entered; nothing is added, split or compared. Whether the
 * projection is a refund or a balance due is only the sign of the API's
 * signed `projected_refund_cents`.
 */

type Outcome = 'refund' | 'due' | 'even';

/** Positive is a refund and negative a balance due (spec 014 rule 10). */
function outcome(cents: number): Outcome {
  const sign = Math.sign(cents);
  return sign > 0 ? 'refund' : sign < 0 ? 'due' : 'even';
}

const magnitude = (cents: number) => formatMoney(Math.abs(cents));

/** The result's headline: "A $0.08 refund at tax time", "$3,449.92 due at tax time". */
export function refundHeadline(cents: number): string {
  switch (outcome(cents)) {
    case 'refund':
      return `A ${magnitude(cents)} refund at tax time`;
    case 'due':
      return `${magnitude(cents)} due at tax time`;
    default:
      return 'Even at tax time';
  }
}

/** What the person would get or owe after the suggestion: "get a $6.08 refund", "owe $0.10". */
function landing(cents: number): string {
  switch (outcome(cents)) {
    case 'refund':
      return `get a ${magnitude(cents)} refund`;
    case 'due':
      return `owe ${magnitude(cents)}`;
    default:
      return 'owe nothing and get no refund';
  }
}

/**
 * A balance due is the off status; a refund is neutral, never confirmed: an
 * interest-free loan to the IRS is not a success to color green.
 */
export const refundTone = (cents: number): Tone => (outcome(cents) === 'due' ? 'off' : 'neutral');

/** The calculator's suggestion in words, or null when it suggests nothing (spec 014 rule 14). */
export function suggestionText(result: W4Result): string | null {
  const after = `You would then ${landing(result.suggested_refund_cents)} at tax time.`;
  switch (result.suggestion) {
    case 'increase_extra_withholding':
      return `Enter ${formatMoney(result.suggested_extra_withholding_cents)} in Step 4(c) to have that much more taken out of each paycheck. ${after}`;
    case 'decrease_extra_withholding':
      return `Lower Step 4(c) to ${formatMoney(result.suggested_extra_withholding_cents)} a paycheck. ${after}`;
    case 'increase_deductions':
      return `Enter ${formatMoney(result.suggested_deductions_cents)} in Step 4(b). ${after} This is more than the deductions you expect to claim, so those go in "Deductions you expect to claim" and the estimate still uses them.`;
    default:
      return null;
  }
}

export type AppliedEntries = Pick<
  W4Input,
  'extra_withholding_cents' | 'deductions_cents' | 'expected_deductions_cents'
>;

/**
 * The entries "Apply suggestion" fills in: the suggested Step 4(c) and 4(b)
 * entries as the calculator returned them. When Step 4(b) grows past the
 * deductions the person expects, their own Step 4(b) entry is kept as the
 * expected deductions, so the projection still taxes what they will claim
 * (spec 014 rule 13). Copies only.
 */
export function appliedEntries(inputs: W4Input, result: W4Result): AppliedEntries {
  const keepExpected =
    result.suggestion === 'increase_deductions' && inputs.expected_deductions_cents == null;
  return {
    extra_withholding_cents: result.suggested_extra_withholding_cents,
    deductions_cents: result.suggested_deductions_cents,
    expected_deductions_cents: keepExpected
      ? inputs.deductions_cents
      : (inputs.expected_deductions_cents ?? null),
  };
}

export interface FromDecisions {
  /** The saved 401(k) decision's contribution, as stored ("4.00"), or null without one. */
  k401Pct: string | null;
  /** The saved health plan decision's chosen plan and its premium per paycheck, or null. */
  premium: { cents: number; plan: string } | null;
}

/** What the W-4 reads from the other saved decisions (spec 014: the client passes them in). */
export function fromDecisions(
  k401: Decision | undefined,
  health: Decision | undefined,
): FromDecisions {
  const k401Inputs = k401 ? asK401Inputs(k401.inputs) : null;
  const healthInputs = health ? asHealthPlansInputs(health.inputs) : null;
  const index = healthInputs?.selected_plan_index;
  const plan = index == null ? undefined : healthInputs?.plans[index];
  return {
    k401Pct: k401Inputs ? String(k401Inputs.contribution_pct) : null,
    premium: plan ? { cents: plan.premium_per_period_cents, plan: plan.name } : null,
  };
}

/**
 * Inputs that describe payroll today, not an entry on the form: a saved
 * decision stays saved when only these differ (spec 014 rule 17a), so a newer
 * stub alone never makes the W-4 look changed.
 */
export const W4_CONTEXT_INPUTS = [
  'current_withholding_per_paycheck_cents',
] as const satisfies readonly (keyof W4Input)[];

const TABLES: Record<W4Result['withholding_schedule'], string> = {
  standard: 'The IRS withholding tables',
  step2_checkbox: 'The IRS withholding tables for two jobs',
};

/**
 * How the paycheck's withholding was worked out, in words (spec 014 rule 21):
 * the schedule the calculator used and the rate of its row. The publication
 * is a source link beside it, never part of the sentence.
 */
export const methodText = (result: W4Result) =>
  `${TABLES[result.withholding_schedule]} take ${formatRate(result.withholding_rate_pct)} of each extra dollar of pay.`;

/** Pub 15-T, the withholding tables the calculator follows. */
export const WITHHOLDING_TABLES_SOURCE = 'https://www.irs.gov/publications/p15t';

export interface W4Entries {
  /** Step 2(c)'s box. */
  multipleJobs: boolean;
  /** The readings of Steps 2 to 4's amounts. */
  amounts: readonly ReadAmount[];
  /** The reading of "Deductions you expect to claim" (empty means the Step 4(b) entry). */
  expected: ReadAmount;
}

/**
 * Whether the entries behind "Anything else on your W-4?" hold anything
 * (spec 014 rule 20): the box checked, an amount that is not 0 (an empty one
 * or one that does not read included, so its field shows), or expected
 * deductions set. A comparison with zero to decide what to show, never an
 * amount worked out.
 */
export function hasMoreEntries({ multipleJobs, amounts, expected }: W4Entries): boolean {
  return (
    multipleJobs ||
    amounts.some((read) => read.cents !== 0) ||
    expected.cents !== null ||
    expected.error !== null
  );
}
