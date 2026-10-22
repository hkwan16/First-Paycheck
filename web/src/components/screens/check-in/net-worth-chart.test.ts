import { describe, expect, it } from 'vitest';
import { sampleNetWorth } from '@/test/fixtures/checkins';
import { formatAxisMoney, NET_WORTH_SERIES, netWorthChartData } from './net-worth-chart';

describe('netWorthChartData', () => {
  it('maps each month of the API series to one chart row, amounts untouched', () => {
    expect(netWorthChartData(sampleNetWorth().series)).toEqual([
      {
        month: '2026-09-01',
        tick: 'Sep',
        name: 'Sep 2026',
        asOf: '2026-09-30',
        netWorth: 450_000,
        assets: 450_000,
        liabilities: 0,
      },
      {
        month: '2026-10-01',
        tick: 'Oct',
        name: 'Oct 2026',
        asOf: '2026-10-31',
        netWorth: 465_000,
        assets: 510_000,
        liabilities: 45_000,
      },
      {
        month: '2026-11-01',
        tick: 'Nov',
        name: 'Nov 2026',
        asOf: '2026-11-16',
        netWorth: 547_754,
        assets: 607_754,
        liabilities: 60_000,
      },
    ]);
  });

  it('is empty when there are no balances yet', () => {
    expect(netWorthChartData([])).toEqual([]);
  });
});

describe('NET_WORTH_SERIES', () => {
  it('draws net worth, assets and liabilities in fixed hues, never a status', () => {
    expect(NET_WORTH_SERIES.map((s) => [s.key, s.label, s.tone])).toEqual([
      ['netWorth', 'Net worth', 'blue'],
      ['assets', 'Assets', 'teal'],
      ['liabilities', 'Liabilities', 'coral'],
    ]);
  });
});

describe('formatAxisMoney', () => {
  it('labels the axis in whole dollars, compact from a thousand', () => {
    expect(formatAxisMoney(0)).toBe('$0');
    expect(formatAxisMoney(45_000)).toBe('$450');
    expect(formatAxisMoney(600_000)).toBe('$6K');
    expect(formatAxisMoney(150_000)).toBe('$1.5K');
    expect(formatAxisMoney(125_000_000)).toBe('$1.25M');
  });
});
