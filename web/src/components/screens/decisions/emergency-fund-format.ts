import type {
  Account,
  Decision,
  EmergencyFundInput,
  EmergencyFundResult,
  Goal,
  GoalStatus,
  SpendingSummary,
} from '@/lib/api/types';
import { maskLabel } from '@/lib/accounts';
import { formatDate } from '@/lib/dates';
import type { Tone } from '@/lib/design/tone';
import { formatMoney } from '@/lib/money';

/*
 * Words and tones for the emergency fund card, kept pure so they can be
 * tested on their own. Every amount is a field the API returned; these only
 * pick words for it.
 */

const dollars = (cents: number) => formatMoney(cents, { decimals: 0 });

/**
 * The example monthly transfer, in the empty field's placeholder and in what
 * to fix. Only an example: nothing the person has confirmed says what they
 * will move each month until they save a decision, which then fills it.
 */
export const CONTRIBUTION_EXAMPLE = '300.00';

/**
 * A count of months as words. With `years`, a whole number of years reads as
 * years ("10 years" for the calculator's 120-month horizon): a duration, not
 * money.
 */
export function monthsText(months: number, { years = false } = {}): string {
  if (years && months >= 12 && months % 12 === 0) {
    const count = months / 12;
    return `${count} ${count === 1 ? 'year' : 'years'}`;
  }
  return `${months} ${months === 1 ? 'month' : 'months'}`;
}

/** The result panel's headline: the target and when the monthly transfer reaches it. */
export function fundHeadline(result: EmergencyFundResult): string {
  const target = dollars(result.target_cents);
  if (result.funded) return `Your savings already cover the ${target} target`;
  if (result.months_to_target === null) {
    return `Target ${target}, not within ${monthsText(result.horizon_months, { years: true })} at this amount`;
  }
  return `Target ${target}, reached in ${monthsText(result.months_to_target)}`;
}

/** The progress bar: the emergency fund's hue while saving, confirmed once funded. */
export const fundBarTone = (result: Pick<EmergencyFundResult, 'funded'>): Tone =>
  result.funded ? 'confirmed' : 'teal';

const GOAL_STATUS: Record<GoalStatus, { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'teal' },
  paused: { label: 'Paused', tone: 'neutral' },
  // Green means done, so only a reached goal is green.
  reached: { label: 'Reached', tone: 'confirmed' },
};

export const goalStatusBadge = (status: GoalStatus) => GOAL_STATUS[status];

/**
 * The goal's monthly contribution when it was changed after the decision was
 * saved (`PATCH /goals/{id}`), so the card starts from it (spec 011 rule
 * 17b); null while the goal holds the saved amount or belongs to another
 * version. Picks which API value to show; nothing is computed.
 */
export function goalContributionOf(
  goal: Goal | undefined,
  current: Decision | undefined,
  saved: EmergencyFundInput | null,
): number | null {
  if (!goal || !current || !saved || goal.decision_id !== current.id) return null;
  const amount = goal.monthly_contribution_cents;
  return amount === saved.monthly_contribution_cents ? null : amount;
}

export interface GoalPaceContext {
  /** The saved decision found the fund already at its target. */
  funded: boolean;
  /** The calculator's projection horizon, from the saved result (null if it has none). */
  horizonMonths: number | null;
}

/**
 * When the goal gets there, in the API's own date: the date it was reached,
 * the projected date at its contribution (spec 011 rule 17a), or why there
 * is none.
 */
export function goalPace(goal: Goal, { funded, horizonMonths }: GoalPaceContext): string {
  if (goal.status === 'reached' && goal.reached_at) {
    return `Reached on ${formatDate(goal.reached_at)}.`;
  }
  // A paused goal gets no contributions, so no date is a pace it keeps (issue 166).
  if (goal.status === 'paused') return 'No projected date while it is paused.';
  if (goal.target_date) return `On pace to reach it by ${formatDate(goal.target_date)}.`;
  if (funded) return 'Your savings already cover it.';
  if (horizonMonths === null) return 'Not reached at this amount.';
  return `Not within ${monthsText(horizonMonths, { years: true })} at this amount.`;
}

/**
 * The monthly essentials to start from: the spending summary's, when it
 * reports essential spending. A summary with none (no transactions, or only
 * refunds) gives nothing to start from, so the person types it.
 */
export function essentialsPrefill(summary: SpendingSummary | undefined): number | null {
  if (!summary || summary.essentials_cents <= 0) return null;
  return summary.essentials_cents;
}

/** The active account the person marked as their emergency fund, if any. */
export function emergencyAccount(accounts: readonly Account[] | undefined): Account | null {
  return accounts?.find((a) => a.role === 'emergency_fund' && a.is_active) ?? null;
}

/** "Chase Savings ··7730": an account as the cards name it. */
export const accountName = (account: Pick<Account, 'name' | 'mask'>) =>
  [account.name, maskLabel(account.mask)].filter(Boolean).join(' ');
