import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { monthKey, periodOptions, selectedPeriodKey, useToday } from './periods';

describe('monthKey', () => {
  it('is the year and month of a calendar date', () => {
    expect(monthKey('2026-10-17')).toBe('2026-10');
  });
});

describe('periodOptions', () => {
  it('offers this month so far, the last complete month as the default, then earlier months', () => {
    expect(periodOptions('2026-10-17', 4)).toEqual([
      {
        value: '2026-10',
        label: 'October 2026 so far',
        period: { start: '2026-10-01', end: '2026-10-17' },
      },
      // The API's default period: no start or end is sent, so it shares that read.
      { value: '2026-09', label: 'September 2026', period: null },
      {
        value: '2026-08',
        label: 'August 2026',
        period: { start: '2026-08-01', end: '2026-08-31' },
      },
      { value: '2026-07', label: 'July 2026', period: { start: '2026-07-01', end: '2026-07-31' } },
    ]);
  });

  it('crosses year ends and knows month lengths, leap years included', () => {
    const options = periodOptions('2028-03-01', 4);
    expect(options.map((o) => o.value)).toEqual(['2028-03', '2028-02', '2028-01', '2027-12']);
    expect(options[0]!.period).toEqual({ start: '2028-03-01', end: '2028-03-01' });
    expect(options[1]!.period).toBeNull();
    expect(options[2]!.period).toEqual({ start: '2028-01-01', end: '2028-01-31' });
    expect(options[3]!.period).toEqual({ start: '2027-12-01', end: '2027-12-31' });
    expect(periodOptions('2028-04-02', 3)[2]!.period).toEqual({
      start: '2028-02-01',
      end: '2028-02-29',
    });
  });

  it('offers six months by default', () => {
    expect(periodOptions('2026-10-17')).toHaveLength(6);
  });
});

describe('selectedPeriodKey', () => {
  it('is the chosen period, else the month the API answered for', () => {
    expect(selectedPeriodKey({ start: '2026-08-01', end: '2026-08-31' }, undefined)).toBe(
      '2026-08',
    );
    expect(selectedPeriodKey(null, { start: '2026-09-01', end: '2026-09-30' })).toBe('2026-09');
    expect(selectedPeriodKey(null, undefined)).toBe('');
  });
});

describe('useToday', () => {
  afterEach(() => vi.useRealTimers());

  it("is today's UTC date on the client", () => {
    vi.useFakeTimers({ now: new Date('2026-10-17T23:30:00-07:00') });
    expect(renderHook(() => useToday()).result.current).toBe('2026-10-18');
  });
});
