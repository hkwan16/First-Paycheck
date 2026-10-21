import { useSyncExternalStore } from 'react';
import type { Period } from '@/lib/api/hooks/spending';

/*
 * The Spending screen's period choices: whole calendar months in UTC, as the
 * API counts them. Date arithmetic only; no amounts.
 */

export interface PeriodOption {
  /** `YYYY-MM`. */
  value: string;
  label: string;
  /** What to ask the API for; null is its default, the last complete month. */
  period: Period | null;
}

const MONTH_YEAR = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

const pad = (n: number) => String(n).padStart(2, '0');

/** `2026-10` for `2026-10-17`. */
export const monthKey = (date: string) => date.slice(0, 7);

/** Months back from `today`'s month (0 is this month), as its first day in UTC. */
function monthStart(today: string, back: number): Date {
  const [year, month] = today.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, month - 1 - back, 1));
}

const isoDate = (date: Date) =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

/**
 * This month so far, the last complete month (the API's default, sent as no
 * period so it shares that read), then the months before it: `count` in all.
 */
export function periodOptions(today: string, count = 6): PeriodOption[] {
  return Array.from({ length: count }, (_, back) => {
    const first = monthStart(today, back);
    const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
    const start = isoDate(first);
    const label = MONTH_YEAR.format(first);
    if (back === 0) {
      return { value: monthKey(start), label: `${label} so far`, period: { start, end: today } };
    }
    return {
      value: monthKey(start),
      label,
      period: back === 1 ? null : { start, end: isoDate(last) },
    };
  });
}

/** The picker's value: the chosen period's month, else the month the API answered for. */
export function selectedPeriodKey(chosen: Period | null, answered: Period | undefined): string {
  if (chosen) return monthKey(chosen.start);
  return answered ? monthKey(answered.start) : '';
}

const noop = () => () => {};
const todayUtc = () => new Date().toISOString().slice(0, 10);
const onServer = () => null;

/**
 * Today's UTC date, `YYYY-MM-DD`, on the client; null on the server and while
 * hydrating, so the HTML never depends on whose clock rendered it.
 */
export function useToday(): string | null {
  return useSyncExternalStore(noop, todayUtc, onServer);
}
