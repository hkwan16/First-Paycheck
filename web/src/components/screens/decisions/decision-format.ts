import type { DecisionSaveState } from '@/lib/decisions';
import type { K401MatchResult, MatchTier } from '@/lib/api/types';
import type { Tone } from '@/lib/design/tone';
import { formatMoney, formatRate } from '@/lib/money';

/** The save badge: not saved yet, changed since the saved version, or saved. */
export function saveBadgeTone(status: DecisionSaveState['status']): Tone {
  return status === 'saved' ? 'confirmed' : status === 'dirty' ? 'warning' : 'neutral';
}

const dollars = (cents: number) => formatMoney(cents, { decimals: 0 });

/**
 * The 401(k) result panel's headline, from the calculator's own amounts. It
 * only asks whether an amount the API returned is zero; it never derives one.
 */
export function matchHeadline(result: K401MatchResult): string {
  if (result.employer_match_cents_full === 0) return 'Your plan has no employer match';
  if (result.missed_cents === 0) {
    return `You capture the full ${dollars(result.employer_match_cents_full)} match`;
  }
  if (result.employer_match_cents_current === 0) {
    return `You leave the whole ${dollars(result.missed_cents)} match behind`;
  }
  return `You leave ${dollars(result.missed_cents)} of match behind`;
}

/**
 * The match formula in words. Tiers are cumulative bounds (spec 006), so each
 * is read as "up to" its bound rather than as a width worked out here.
 */
export function tiersText(tiers: readonly MatchTier[]): string {
  return tiers
    .map(({ employer_pct, employee_pct_upto }, index) =>
      index === 0
        ? `${formatRate(employer_pct)} of the first ${formatRate(employee_pct_upto)}`
        : `${formatRate(employer_pct)} up to ${formatRate(employee_pct_upto)}`,
    )
    .join(', then ');
}
