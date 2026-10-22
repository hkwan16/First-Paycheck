import type { AccountKind } from '@/lib/api/types';

/** "··4821", the mockup's way of showing an account's last digits. */
export function maskLabel(mask: string | null): string | null {
  return mask ? `··${mask}` : null;
}

/** What each account kind is called, in the API's `account_kind` order. */
export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  checking: 'Checking',
  savings: 'Savings',
  credit: 'Credit card',
  loan: 'Loan',
  investment: 'Investment',
  retirement: 'Retirement',
};
