import type { CategorySource, SpendingSummary, Transaction } from '@/lib/api/types';
import { parseISODate } from '@/lib/dates';
import type { Tone } from '@/lib/design/tone';
import { formatNumber, formatPct } from '@/lib/money';

/**
 * What a share of income says when the API sent none: no income, or too
 * little to compare a bucket with (spec 007 rule 25).
 */
export const NO_SHARE = 'n/a, income too small to compare';

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

/**
 * Why rows on loan, investment and retirement accounts are not in the totals
 * (spec 007 rule 21a), or null when the API left none out. A count of rows,
 * never their amount.
 */
export function ledgerNote(skipped: SpendingSummary['ledger_rows_skipped']): string | null {
  if (skipped.count === 0) return null;
  if (skipped.count === 1) {
    return "1 row on a loan, investment or retirement account is left out: it is that account's own ledger, not money you spent or received.";
  }
  return `${formatNumber(skipped.count)} rows on loan, investment and retirement accounts are left out: they are those accounts' own ledgers, not money you spent or received.`;
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

/** Below this confidence an AI label is shown as a warning: worth a look. */
export const LOW_CONFIDENCE = 0.7;

export interface SourceBadgeView {
  tone: Tone;
  text: string;
}

/**
 * Who labeled a transaction, as the mockup's "Labeled by" badge: the person
 * (confirmed, "You"), the AI with its confidence (blue, amber under 70%), or
 * a rule (neutral).
 */
export function sourceBadge(txn: Transaction): SourceBadgeView {
  switch (txn.category_source) {
    case 'user':
      return { tone: 'confirmed', text: 'You' };
    case 'llm': {
      if (txn.confidence === null) return { tone: 'blue', text: 'AI' };
      // Confidence is 0 to 1; shown as whole percentage points.
      const pct = formatPct(txn.confidence * 100);
      return { tone: txn.confidence < LOW_CONFIDENCE ? 'warning' : 'blue', text: `AI · ${pct}` };
    }
    case 'rule':
      return { tone: 'neutral', text: 'Rule' };
    default:
      return { tone: 'neutral', text: 'Not labeled' };
  }
}

export type SourceCounts = Record<CategorySource, number>;

/** How many of the loaded rows each source labeled (a row count, not money). */
export function countSources(transactions: readonly Transaction[]): SourceCounts {
  const counts: SourceCounts = { rule: 0, llm: 0, user: 0 };
  for (const txn of transactions) {
    if (txn.category_source) counts[txn.category_source] += 1;
  }
  return counts;
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
