import type { SpendingSummary, Transaction } from '@/lib/api/types';
import { parseISODate } from '@/lib/dates';
import type { Tone } from '@/lib/design/tone';
import { formatNumber, formatPct } from '@/lib/money';

/**
 * What a share of income says when the API sent none: no income, or too
 * little to compare a bucket with (spec 007 rule 25).
 */
export const NO_SHARE = 'Too little income to compare';

/**
 * A bucket's share of income as the API rounded it, worded by `words`, or
 * `NO_SHARE` when the API held it back. `decimals` is display precision only.
 */
export function shareText(
  pct: string | null,
  words: (pct: string) => string,
  decimals = 0,
): string {
  return pct === null ? NO_SHARE : words(formatPct(pct, { decimals }));
}

/** Why a loan payment is not counted twice: once leaving checking, once arriving at the loan. */
const COUNTED_ONCE = 'A loan payment counts once, when it leaves checking.';

/**
 * How many transactions on loan, investment and retirement accounts the
 * totals leave out (spec 007 rule 21a), or null when the API left none out.
 * A count, never their amount.
 */
export function ledgerNote(skipped: SpendingSummary['ledger_rows_skipped']): string | null {
  if (skipped.count === 0) return null;
  if (skipped.count === 1) {
    return `Not counted: 1 transaction on a loan, investment or retirement account. ${COUNTED_ONCE}`;
  }
  return `Not counted: ${formatNumber(skipped.count)} transactions on loan, investment and retirement accounts. ${COUNTED_ONCE}`;
}

/**
 * The period's confirmed pay stubs, as a count: "2 pay stubs", "1 pay stub",
 * "no pay stub" (`paycheck_count`, spec 007 rules 26 and 26a). Never
 * "paychecks": a paycheck can be deposited with no stub confirmed for it, and
 * income is those deposits, a separate statement.
 */
export function payStubsText(count: number): string {
  if (count === 0) return 'no pay stub';
  return `${formatNumber(count)} ${count === 1 ? 'pay stub' : 'pay stubs'}`;
}

/** Below this confidence a guessed category asks to be checked. */
export const LOW_CONFIDENCE = 0.7;

export interface SourceBadgeView {
  tone: Tone;
  text: string;
}

/**
 * Where a transaction's category came from, as the mockup's source badge, in
 * the person's words: they set it (confirmed, "You"), we guessed it from the
 * merchant's name (blue, or a warning asking for a check under 70%
 * confidence), or the merchant is one we know (neutral).
 */
export function sourceBadge(txn: Transaction): SourceBadgeView {
  switch (txn.category_source) {
    case 'user':
      return { tone: 'confirmed', text: 'You' };
    case 'llm':
      return txn.confidence !== null && txn.confidence < LOW_CONFIDENCE
        ? { tone: 'warning', text: 'Guess, check it' }
        : { tone: 'blue', text: 'Our guess' };
    case 'rule':
      return { tone: 'neutral', text: 'Known merchant' };
    default:
      return { tone: 'neutral', text: 'No category' };
  }
}

const MONTH = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' });
const MONTH_DAY = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
});
const FULL = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "October" for a `YYYY-MM-DD` calendar date. */
export function monthName(date: string): string {
  return MONTH.format(parseISODate(date));
}

/** "October 1 to 17", "September 28 to October 17", or with years across a year end. */
export function periodText(start: string, end: string): string {
  const from = parseISODate(start);
  const to = parseISODate(end);
  if (from.getUTCFullYear() !== to.getUTCFullYear()) {
    return `${FULL.format(from)} to ${FULL.format(to)}`;
  }
  if (from.getUTCMonth() === to.getUTCMonth()) {
    return `${MONTH_DAY.format(from)} to ${to.getUTCDate()}`;
  }
  return `${MONTH_DAY.format(from)} to ${MONTH_DAY.format(to)}`;
}
