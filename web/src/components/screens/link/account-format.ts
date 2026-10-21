import type { AccountTransactionCount } from '@/lib/api/hooks';
import type { Account, AccountPatch, AccountRole } from '@/lib/api/types';
import { formatDate } from '@/lib/dates';
import { formatNumber } from '@/lib/money';

/** Two letters for an institution's icon tile: "Chase" is CH, "First Platypus Bank" FP. */
export function institutionInitials(name: string | null): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  const [first, second] = words;
  if (!first) return '?';
  const letters = second ? `${first[0]}${second[0]}` : first.slice(0, 2);
  return letters.toUpperCase();
}

/** The role select's value: a role, '' for none chosen yet, or 'unused'. */
export type RoleValue = AccountRole | '' | 'unused';

export const ROLE_OPTIONS: readonly { value: Exclude<RoleValue, ''>; label: string }[] = [
  { value: 'spending', label: 'Spending' },
  { value: 'emergency_fund', label: 'Emergency fund' },
  { value: 'retirement', label: 'Retirement' },
  { value: 'unused', label: 'Not used' },
];

export function roleValue(account: Account): RoleValue {
  if (!account.is_active) return 'unused';
  return account.role ?? '';
}

/** The PATCH for a chosen option. Both fields are sent so each option is one state. */
export function patchForRole(value: Exclude<RoleValue, ''>): AccountPatch {
  return value === 'unused' ? { role: null, is_active: false } : { role: value, is_active: true };
}

export interface InstitutionGroup {
  itemId: string;
  name: string;
  accounts: Account[];
}

/** Accounts grouped by the linked item they came from, in the API's order. */
export function groupByInstitution(accounts: readonly Account[]): InstitutionGroup[] {
  const groups = new Map<string, InstitutionGroup>();
  for (const account of accounts) {
    const group = groups.get(account.sync_item_id) ?? {
      itemId: account.sync_item_id,
      name: account.institution_name ?? 'Linked bank',
      accounts: [],
    };
    group.accounts.push(account);
    groups.set(account.sync_item_id, group);
  }
  return [...groups.values()];
}

/** "94 transactions since Jul 2026", "200+ transactions" or "No transactions yet". */
export function transactionCountText({ count, more, since }: AccountTransactionCount): string {
  if (count === 0) return 'No transactions yet';
  if (more) return `${formatNumber(count)}+ transactions`;
  const noun = count === 1 ? 'transaction' : 'transactions';
  return since
    ? `${formatNumber(count)} ${noun} since ${formatDate(since, 'month-year')}`
    : `${formatNumber(count)} ${noun}`;
}
