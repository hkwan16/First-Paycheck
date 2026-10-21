import { keepPreviousData } from '@tanstack/react-query';
import { $api } from '../client';

/** An inclusive period of calendar dates, `YYYY-MM-DD`. */
export interface Period {
  start: string;
  end: string;
}

const params = (period: Period | null | undefined) =>
  period ? { params: { query: { start: period.start, end: period.end } } } : undefined;

/**
 * `GET /cashflow`: the period's withholding lines (stage 1 of the diagram)
 * beside its spending summary (stages 2 and 3). Without a period the API
 * reads the last complete calendar month. While another period loads, the
 * last one stays on screen (`isPlaceholderData`), so the diagram does not
 * collapse to a skeleton on every change.
 */
export function useCashflow(period: Period | null) {
  return $api.useQuery('get', '/cashflow', params(period), {
    placeholderData: keepPreviousData,
  });
}

/**
 * `GET /spending/summary`: bucket totals, percentages and counts for a
 * period (the last complete month by default). The Spending screen reads the
 * same summary from `useCashflow`; this is for screens that need the totals
 * without the withholding lines.
 */
export function useSpendingSummary(period?: Period | null) {
  return $api.useQuery('get', '/spending/summary', params(period));
}
