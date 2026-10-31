import type { Account, AccountKind } from '@/lib/api/types';

/** "··4821", the mockup's way of showing an account's last digits. */
export function maskLabel(mask: string | null): string | null {
  return mask ? `··${mask}` : null;
}

/**
 * What an account's institution is called on every screen: its name, else
 * where it came from ("Imported CSV" for a file with no bank name, "Linked
 * bank" for a link that sent none). The Link screen's group heading and icon
 * tile and the Spending summary all read this, so they never disagree.
 */
export function institutionName(account: Pick<Account, 'institution_name' | 'provider'>): string {
  const name = account.institution_name?.trim();
  if (name) return name;
  return account.provider === 'csv' ? 'Imported CSV' : 'Linked bank';
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
