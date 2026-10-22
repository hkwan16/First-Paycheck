import { $api } from '../client';

/**
 * `GET /net-worth`: assets, liabilities and net worth now, by account and by
 * kind, and one point per month with data over the last `months` calendar
 * months (1 to 60, ending with this one). Every figure is `calc/net_worth.py`'s.
 */
export function useNetWorth(months: number) {
  return $api.useQuery('get', '/net-worth', { params: { query: { months } } });
}

/**
 * `GET /holdings`: each investment and retirement account's newest
 * positions, with value, cost basis and gain. A basis the institution did not
 * report is null, and so are the account's and the totals' basis and gain.
 */
export function useHoldings() {
  return $api.useQuery('get', '/holdings');
}
