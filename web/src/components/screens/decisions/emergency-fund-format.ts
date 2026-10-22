import type { Account, EmergencyFundResult, GoalStatus, SpendingSummary } from '@/lib/api/types';
import { maskLabel } from '@/lib/accounts';
import type { Tone } from '@/lib/design/tone';
import { formatMoney } from '@/lib/money';

/*
 * Words and tones for the emergency fund card, kept pure so they can be
 * tested on their own. Every amount is a field the API returned; these only
 * pick words for it.
 */

const dollars = (cents: number) => formatMoney(cents, { decimals: 0 });

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
