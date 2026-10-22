import type { NetWorthPoint } from '@/lib/api/types';
import { formatDate } from '@/lib/dates';
import type { Hue } from '@/lib/design/tone';

/** One month of `GET /net-worth`'s series as the chart reads it; amounts in cents, as sent. */
export interface NetWorthRow {
  month: string;
  /** The x-axis label: "Sep". */
  tick: string;
  /** The tooltip and table label: "Sep 2026". */
  name: string;
  /** The day the month's balances were read on (its last day, or today). */
  asOf: string;
  netWorth: number;
  assets: number;
  liabilities: number;
}

export type NetWorthSeriesKey = 'netWorth' | 'assets' | 'liabilities';

export interface NetWorthSeries {
  key: NetWorthSeriesKey;
  label: string;
  tone: Hue;
}

/**
 * The three lines, in legend order. Net worth is the headline (blue);
 * assets take savings' teal; liabilities, mostly card balances, take coral.
 * Checked with the dataviz palette validator (lightness, chroma, CVD
 * separation); teal is under 3:1 on white, so the legend labels every line
 * and the monthly table carries every value.
 */
export const NET_WORTH_SERIES: readonly NetWorthSeries[] = [
  { key: 'netWorth', label: 'Net worth', tone: 'blue' },
  { key: 'assets', label: 'Assets', tone: 'teal' },
  { key: 'liabilities', label: 'Liabilities', tone: 'coral' },
];

const MONTH_TICK = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });

/** Map the API's series to chart rows. Nothing is added or derived: each field is the API's. */
export function netWorthChartData(series: readonly NetWorthPoint[]): NetWorthRow[] {
  return series.map((point) => ({
    month: point.month,
    tick: MONTH_TICK.format(new Date(`${point.month}T00:00:00Z`)),
    name: formatDate(point.month, 'month-year'),
    asOf: point.as_of,
    netWorth: point.net_worth_cents,
    assets: point.assets_cents,
    liabilities: point.liabilities_cents,
  }));
}

const COMPACT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/** A y-axis tick (cents, chosen by the chart) in compact dollars: "$450", "$6K", "$1.25M". */
export function formatAxisMoney(cents: number): string {
  return COMPACT.format(cents / 100);
}
