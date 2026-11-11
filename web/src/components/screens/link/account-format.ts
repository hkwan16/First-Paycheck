import { institutionName, maskLabel } from '@/lib/accounts';
import type { Account, AccountPatch, AccountRole, CsvImport, SyncProvider } from '@/lib/api/types';
import { formatDate } from '@/lib/dates';
import { formatNumber } from '@/lib/money';

/**
 * Two letters for an institution's icon tile: "Chase" is CH, "First Platypus
 * Bank" FP. Pass `institutionName(account)`, the name its group shows.
 */
export function institutionInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const [first, second] = words;
  if (!first) return '?';
  const letters = second ? `${first[0]}${second[0]}` : first.slice(0, 2);
  return letters.toUpperCase();
}

/** The role select's value: a role, '' for no role, or 'unused'. */
export type RoleValue = AccountRole | '' | 'unused';

const ROLE_LABELS: Record<AccountRole, string> = {
  spending: 'Spending',
  emergency_fund: 'Emergency fund',
  retirement: 'Retirement',
};

/**
 * The role select's options: "No role", the roles the API says the account's
 * kind allows (spec 002 rule 31a; a loan has none), and "Not used". Every
 * one can be chosen, so a role once set can be cleared (issue 241).
 */
export function roleOptions(
  account: Pick<Account, 'allowed_roles'>,
): { value: RoleValue; label: string }[] {
  return [
    { value: '', label: 'No role' },
    ...account.allowed_roles.map((role) => ({ value: role, label: ROLE_LABELS[role] })),
    { value: 'unused', label: 'Not used' },
  ];
}

/** "Role for Chase Total Checking ··4821": each select named for its account (issue 242). */
export const roleSelectName = (account: Pick<Account, 'name' | 'mask'>) =>
  ['Role for', account.name, maskLabel(account.mask)].filter(Boolean).join(' ');

export function roleValue(account: Pick<Account, 'role' | 'is_active'>): RoleValue {
  if (!account.is_active) return 'unused';
  return account.role ?? '';
}

/** The PATCH for a chosen option. Both fields are sent so each option is one state. */
export function patchForRole(value: RoleValue): AccountPatch {
  if (value === 'unused') return { role: null, is_active: false };
  return { role: value === '' ? null : value, is_active: true };
}

/**
 * Where a CSV can be imported besides a new account: only an account an
 * earlier import made (spec 010 rule 17, issue 241). A linked bank's accounts,
 * loans among them, fill from the bank, and the API refuses them.
 */
export const csvImportTargets = (accounts: readonly Account[]) =>
  accounts.filter((account) => account.provider === 'csv');

const transactions = (count: number) =>
  `${formatNumber(count)} ${count === 1 ? 'transaction' : 'transactions'}`;

/**
 * What an import did, from the API's two counts (spec 010 rule 15a, issue
 * 231): the rows it added and the ones the account already had.
 */
export function importResultText({
  account,
  added,
  already_present: present,
}: Pick<CsvImport, 'account' | 'added' | 'already_present'>): string {
  if (added === 0) {
    return present === 1
      ? `No new transactions: the one in the file was already in ${account.name}.`
      : `No new transactions: all ${formatNumber(present)} were already in ${account.name}.`;
  }
  const lead = `Added ${transactions(added)} to ${account.name}.`;
  if (present === 0) return lead;
  return `${lead} ${formatNumber(present)} ${present === 1 ? 'was' : 'were'} already there.`;
}

export interface InstitutionGroup {
  itemId: string;
  name: string;
  /** A bank linked through Plaid, or a CSV file imported (no sync, removed rather than unlinked). */
  provider: SyncProvider;
  accounts: Account[];
}

/** Accounts grouped by the linked item they came from, in the API's order. */
export function groupByInstitution(accounts: readonly Account[]): InstitutionGroup[] {
  const groups = new Map<string, InstitutionGroup>();
  for (const account of accounts) {
    const group = groups.get(account.sync_item_id) ?? {
      itemId: account.sync_item_id,
      name: institutionName(account),
      provider: account.provider,
      accounts: [],
    };
    group.accounts.push(account);
    groups.set(account.sync_item_id, group);
  }
  return [...groups.values()];
}

export interface RemovalWords {
  /** The control and the confirmation's question: "Unlink Chase?". */
  verb: 'Unlink' | 'Remove';
  /** The done notice: "Unlinked Chase.". */
  done: 'Unlinked' | 'Removed';
  /** What the person can do afterwards. */
  again: string;
}

/**
 * The words for taking an institution away: a linked bank is unlinked and can
 * be linked again; an imported file's account is removed (nothing is
 * disconnected at a bank) and the file can be imported again.
 */
export function removalWords(provider: SyncProvider): RemovalWords {
  return provider === 'csv'
    ? { verb: 'Remove', done: 'Removed', again: 'You can import the file again later.' }
    : { verb: 'Unlink', done: 'Unlinked', again: 'You can link it again later.' };
}

/** What unlinking an institution with `count` accounts deletes, as a sentence's subject. */
export function ownedText(count: number): string {
  return count === 1
    ? 'Its account and its transactions'
    : `Its ${formatNumber(count)} accounts and their transactions`;
}

/** "94 transactions since Jul 2026" or "No transactions yet", from the API's count (spec 002 rule 30a). */
export function transactionCountText({
  transaction_count: count,
  first_posted_at: since,
}: Pick<Account, 'transaction_count' | 'first_posted_at'>): string {
  if (count === 0) return 'No transactions yet';
  return since
    ? `${transactions(count)} since ${formatDate(since, 'month-year')}`
    : transactions(count);
}
