import type { CategorySource, Transaction } from '@/lib/api/types';
import { parseISODate } from '@/lib/dates';
import type { Tone } from '@/lib/design/tone';
import { formatPct } from '@/lib/money';

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
