import { describe, expect, it } from 'vitest';
import { calendarParts, formatDate, formatDateTime, formatRelative, parseISODate } from './dates';

describe('parseISODate', () => {
  it('reads a calendar date as UTC midnight so it never shifts a day', () => {
    expect(parseISODate('2026-10-20').toISOString()).toBe('2026-10-20T00:00:00.000Z');
  });

  it('reads a timestamp with its offset', () => {
    expect(parseISODate('2026-10-20T15:12:00-07:00').toISOString()).toBe(
      '2026-10-20T22:12:00.000Z',
    );
  });

  it.each(['', '2026-13-01', '2026-02-30', 'Oct 20', '2026-10-20T25:00:00Z'])(
    'rejects %j',
    (bad) => {
      expect(() => parseISODate(bad)).toThrow(RangeError);
    },
  );
});

describe('formatDate', () => {
  it('formats a calendar date in medium style by default', () => {
    expect(formatDate('2026-10-20')).toBe('Oct 20, 2026');
  });

  it('formats short and month-year styles', () => {
    expect(formatDate('2026-10-20', 'short')).toBe('Oct 20');
    expect(formatDate('2027-10-01', 'month-year')).toBe('Oct 2027');
  });

  it('formats Jan 1 as Jan 1 in every time zone', () => {
    expect(formatDate('2027-01-01')).toBe('Jan 1, 2027');
  });
});

describe('calendarParts', () => {
  it('splits a date for the decision calendar', () => {
    expect(calendarParts('2026-11-14')).toEqual({ month: 'Nov', day: '14', year: '2026' });
  });
});

describe('formatDateTime', () => {
  it('reads "Oct 20, 2026 at 3:12 PM" in the given time zone with plain spaces', () => {
    expect(formatDateTime('2026-10-20T22:12:00Z', { timeZone: 'America/Los_Angeles' })).toBe(
      'Oct 20, 2026 at 3:12 PM',
    );
  });
});

describe('formatRelative', () => {
  const now = new Date('2026-10-20T22:12:00Z');
  it.each([
    ['2026-10-20T22:11:30Z', 'just now'],
    ['2026-10-20T22:11:00Z', '1 minute ago'],
    ['2026-10-20T22:08:00Z', '4 minutes ago'],
    ['2026-10-20T19:12:00Z', '3 hours ago'],
    ['2026-10-19T22:12:00Z', 'yesterday'],
    ['2026-10-10T22:12:00Z', '10 days ago'],
    ['2026-07-20T22:12:00Z', '3 months ago'],
    ['2024-10-20T22:12:00Z', '2 years ago'],
    ['2026-10-23T22:12:00Z', 'in 3 days'],
  ])('%s is %j', (iso, expected) => {
    expect(formatRelative(iso, now)).toBe(expected);
  });
});
