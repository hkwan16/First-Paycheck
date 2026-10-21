/**
 * Date display. The API sends calendar dates as `YYYY-MM-DD` (pay dates,
 * deadlines) and instants as ISO 8601 timestamps with an offset.
 *
 * A calendar date is a day, not an instant, so it is read and formatted in
 * UTC and never shifts across time zones. A timestamp is formatted in the
 * viewer's time zone unless one is given.
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

const isDateOnly = (value: string) => DATE_ONLY.test(value);

/** Parse an ISO calendar date or timestamp, or throw RangeError. */
export function parseISODate(value: string): Date {
  const parts = DATE_ONLY.exec(value);
  if (parts) {
    const [year, month, day] = parts.slice(1).map(Number) as [number, number, number];
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    ) {
      return date;
    }
  } else if (TIMESTAMP.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  throw new RangeError(`Not an ISO 8601 date: ${JSON.stringify(value)}`);
}

export type DateStyle = 'medium' | 'short' | 'month-year';

export interface ZoneOptions {
  /** IANA zone for timestamps; calendar dates always use UTC. */
  timeZone?: string;
}

const STYLES: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  medium: { month: 'short', day: 'numeric', year: 'numeric' },
  short: { month: 'short', day: 'numeric' },
  'month-year': { month: 'short', year: 'numeric' },
};

function zoneFor(value: string, options: ZoneOptions): string | undefined {
  return isDateOnly(value) ? 'UTC' : options.timeZone;
}

/** Intl puts narrow no-break spaces before AM/PM; screens and tests want plain spaces. */
const plainSpaces = (text: string) => text.replace(/[  ]/g, ' ');

/** `"2026-10-20"` to `"Oct 20, 2026"` (medium), `"Oct 20"` (short), `"Oct 2026"` (month-year). */
export function formatDate(
  value: string,
  style: DateStyle = 'medium',
  options: ZoneOptions = {},
): string {
  const format = new Intl.DateTimeFormat('en-US', {
    ...STYLES[style],
    timeZone: zoneFor(value, options),
  });
  return plainSpaces(format.format(parseISODate(value)));
}

/** `"Oct 20, 2026 at 3:12 PM"`. */
export function formatDateTime(value: string, options: ZoneOptions = {}): string {
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: options.timeZone,
  }).format(parseISODate(value));
  return `${formatDate(value, 'medium', options)} at ${plainSpaces(time)}`;
}

export interface CalendarParts {
  month: string;
  day: string;
  year: string;
}

/** Month, day and year for the decision calendar's date column. */
export function calendarParts(value: string, options: ZoneOptions = {}): CalendarParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: zoneFor(value, options),
  }).formatToParts(parseISODate(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return { month: part('month'), day: part('day'), year: part('year') };
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30.44 * DAY;
const YEAR = 365.25 * DAY;
const relative = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });

/** `"4 minutes ago"`, `"yesterday"`, `"in 3 days"`; under 45 seconds is `"just now"`. */
export function formatRelative(value: string, now: Date = new Date()): string {
  const seconds = (parseISODate(value).getTime() - now.getTime()) / 1000;
  const abs = Math.abs(seconds);
  if (abs < 45) return 'just now';
  if (abs < HOUR) return relative.format(Math.round(seconds / MINUTE), 'minute');
  if (abs < DAY) return relative.format(Math.round(seconds / HOUR), 'hour');
  if (abs < 30 * DAY) return relative.format(Math.round(seconds / DAY), 'day');
  if (abs < YEAR) return relative.format(Math.round(seconds / MONTH), 'month');
  return relative.format(Math.round(seconds / YEAR), 'year');
}
