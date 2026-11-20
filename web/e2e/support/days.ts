/*
 * Dates for persons-day.spec.ts (spec 019, issue 232). The local stack's API,
 * worker, Postgres and Auth stand-in all run on the real clock, so the spec
 * moves the person instead of the clock: the browser runs in a zone whose
 * date is not UTC's while the test runs.
 */

/**
 * A zone whose date differs from UTC's at `now` and for at least the next
 * hour (spec 019, "The e2e test's zone"): the evening before in Los Angeles
 * until 06:00 UTC and in Pago Pago (UTC-11) until 10:00 UTC, then the next
 * morning in Kiritimati (UTC+14). Only in the hour before UTC midnight can
 * the dates meet before the test ends.
 */
export function zoneOffTheUtcDate(now: Date): string {
  const hour = now.getUTCHours();
  if (hour < 6) return 'America/Los_Angeles';
  if (hour < 10) return 'Pacific/Pago_Pago';
  return 'Pacific/Kiritimati';
}

/** The `YYYY-MM-DD` date in `zone` at `at`. */
export function dateIn(zone: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

const asUtc = (date: string) => new Date(`${date}T00:00:00Z`);
const iso = (date: Date) => date.toISOString().slice(0, 10);

/** `date` plus `days` calendar days. */
export function addDays(date: string, days: number): string {
  const next = asUtc(date);
  next.setUTCDate(next.getUTCDate() + days);
  return iso(next);
}

/** The first day of `date`'s month. */
export const monthStart = (date: string) => `${date.slice(0, 8)}01`;

const words = (options: Intl.DateTimeFormatOptions) => (date: string) =>
  new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(asUtc(date));

/** "Nov 9, 2026", as the screens print a calendar date (`formatDate`). */
export const mediumDate = words({ month: 'short', day: 'numeric', year: 'numeric' });

/** "November 2026", as the period picker and the check-in list name a month. */
export const monthYear = words({ month: 'long', year: 'numeric' });

/** "November 1 to 9", as Spending names a period within one month (`periodText`). */
export function periodWithinMonth(start: string, end: string): string {
  return `${words({ month: 'long', day: 'numeric' })(start)} to ${Number(end.slice(8))}`;
}
