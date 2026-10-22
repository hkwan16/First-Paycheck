import { apiErrorCode, apiErrorMessage } from '@/lib/api/errors';
import { ResultMismatch } from '@/lib/api/hooks';
import type { DecisionSaveState } from '@/lib/decisions';
import type { K401MatchResult, MatchTier, MatchTierIn } from '@/lib/api/types';
import type { Tone } from '@/lib/design/tone';
import { formatMoney, formatRate, parseMoney } from '@/lib/money';

/** The save badge: not saved yet, changed since the saved version, or saved. */
export function saveBadgeTone(status: DecisionSaveState['status']): Tone {
  return status === 'saved' ? 'confirmed' : status === 'dirty' ? 'warning' : 'neutral';
}

const dollars = (cents: number) => formatMoney(cents, { decimals: 0 });

export interface ReadAmount {
  /** Integer cents, or null when nothing usable is typed. */
  cents: number | null;
  /** What to fix, or null when the field is empty or reads. */
  error: string | null;
}

/**
 * An amount a person typed on a card, as cents (`parseMoney`), or what to fix.
 * Empty is not an error: the field is simply not filled in yet. `positive`
 * refuses $0 for amounts the calculator needs above zero.
 */
export function readAmount(
  text: string,
  { example, positive = false }: { example: string; positive?: boolean },
): ReadAmount {
  if (text.trim() === '') return { cents: null, error: null };
  const cents = parseMoney(text);
  const ok = cents !== null && (positive ? cents > 0 : cents >= 0);
  if (ok) return { cents, error: null };
  return {
    cents: null,
    error: positive
      ? `Enter an amount above $0, like ${example}.`
      : `Enter an amount, like ${example}.`,
  };
}

/**
 * A placeholder for a field nothing on hand can fill: "for example 300.00".
 * A bare figure reads as a value already entered, and the person then wonders
 * why the card asks for it; the words say it is only an example. A field the
 * API can fill takes the API's value instead, never a placeholder.
 */
export const examplePlaceholder = (example: string) => `for example ${example}`;

/** Cents as a person types them in an amount field: `182325` is `"1,823.25"`; null is empty. */
export const amountText = (cents: number | null | undefined) =>
  cents == null ? '' : formatMoney(cents).replace('$', '');

/** Why a decision did not save, as a sentence, for every calculator card. */
export function saveErrorText(error: unknown): string {
  if (error instanceof ResultMismatch) {
    return "The calculator's numbers had changed since they were shown. They are up to date now: check them and save again.";
  }
  switch (apiErrorCode(error)) {
    case 'decision_conflict':
      return 'This decision was saved somewhere else since you opened it, so the latest version is loaded. Save again to replace it with these numbers.';
    case 'plan_not_selected':
      return 'Choose the plan you will enroll in, then save.';
    default:
      return apiErrorMessage(error, 'Could not save this decision. Try again.');
  }
}

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
export function tiersText(tiers: readonly (MatchTier | MatchTierIn)[]): string {
  return tiers
    .map(({ employer_pct, employee_pct_upto }, index) =>
      index === 0
        ? `${formatRate(employer_pct)} of the first ${formatRate(employee_pct_upto)}`
        : `${formatRate(employer_pct)} up to ${formatRate(employee_pct_upto)}`,
    )
    .join(', then ');
}
