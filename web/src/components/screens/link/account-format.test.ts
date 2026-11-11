import { describe, expect, it } from 'vitest';
import { sampleAccounts, sampleCsvAccount } from '@/test/fixtures/sample';
import {
  csvImportTargets,
  groupByInstitution,
  importResultText,
  institutionInitials,
  ownedText,
  patchForRole,
  removalWords,
  roleOptions,
  roleSelectName,
  roleValue,
  transactionCountText,
} from './account-format';

const [checking, savings] = sampleAccounts as [
  (typeof sampleAccounts)[0],
  (typeof sampleAccounts)[0],
];

describe('institutionInitials', () => {
  it.each([
    ['Chase', 'CH'],
    ['First Platypus Bank', 'FP'],
    ['  bank of   the west ', 'BO'],
    ['Imported CSV', 'IC'],
    ['', '?'],
  ])('%j reads %s', (name, initials) => {
    expect(institutionInitials(name)).toBe(initials);
  });
});

describe('account roles', () => {
  it('reads the select value from role and active flag', () => {
    expect(roleValue(checking)).toBe('spending');
    expect(roleValue(savings)).toBe('emergency_fund');
    expect(roleValue({ ...checking, role: null })).toBe('');
    expect(roleValue({ ...checking, role: 'spending', is_active: false })).toBe('unused');
  });

  it('sends both fields, so "Not used" also clears the role and "No role" keeps it active', () => {
    expect(patchForRole('retirement')).toEqual({ role: 'retirement', is_active: true });
    expect(patchForRole('unused')).toEqual({ role: null, is_active: false });
    // Issue 241: a role once set can be cleared.
    expect(patchForRole('')).toEqual({ role: null, is_active: true });
  });

  it("offers no role, the kind's roles from the API, and not used (issue 241)", () => {
    expect(roleOptions({ ...checking, allowed_roles: ['spending', 'emergency_fund'] })).toEqual([
      { value: '', label: 'No role' },
      { value: 'spending', label: 'Spending' },
      { value: 'emergency_fund', label: 'Emergency fund' },
      { value: 'unused', label: 'Not used' },
    ]);
    expect(roleOptions({ allowed_roles: [] })).toEqual([
      { value: '', label: 'No role' },
      { value: 'unused', label: 'Not used' },
    ]);
  });

  it('names each select for its account (issue 242)', () => {
    expect(roleSelectName(checking)).toBe('Role for Chase Total Checking ··4821');
    expect(roleSelectName({ ...checking, mask: null })).toBe('Role for Chase Total Checking');
  });
});

describe('csvImportTargets', () => {
  it("offers only accounts a CSV import made, never a linked bank's (issue 241)", () => {
    const loan = { ...checking, id: 'loan', kind: 'loan' as const, name: 'Plaid Mortgage' };
    expect(csvImportTargets([checking, loan, sampleCsvAccount, savings])).toEqual([
      sampleCsvAccount,
    ]);
  });
});

describe('importResultText', () => {
  const account = { ...sampleCsvAccount, name: 'E2E CSV Checking' };
  it.each([
    [5, 0, 'Added 5 transactions to E2E CSV Checking.'],
    [1, 0, 'Added 1 transaction to E2E CSV Checking.'],
    [1, 4, 'Added 1 transaction to E2E CSV Checking. 4 were already there.'],
    [3, 1, 'Added 3 transactions to E2E CSV Checking. 1 was already there.'],
    [0, 5, 'No new transactions: all 5 were already in E2E CSV Checking.'],
    [0, 1, 'No new transactions: the one in the file was already in E2E CSV Checking.'],
  ])('%i added and %i already there reads %j (issue 231)', (added, present, text) => {
    expect(importResultText({ account, added, already_present: present })).toBe(text);
  });
});

describe('groupByInstitution', () => {
  it('keeps API order and groups accounts by their linked item', () => {
    const other = { ...checking, id: 'x', sync_item_id: 'item-2', institution_name: 'Ally' };
    const groups = groupByInstitution([checking, savings, other]);
    expect(groups.map((g) => [g.itemId, g.name, g.accounts.length])).toEqual([
      [checking.sync_item_id, 'Chase', 2],
      ['item-2', 'Ally', 1],
    ]);
  });

  it('names an institution without a name', () => {
    const [group] = groupByInstitution([{ ...checking, institution_name: null }]);
    expect(group?.name).toBe('Linked bank');
  });

  it('carries where the institution came from: a bank link or an imported file', () => {
    const groups = groupByInstitution([checking, sampleCsvAccount]);
    expect(groups.map((g) => [g.name, g.provider])).toEqual([
      ['Chase', 'plaid'],
      ['Credit union', 'csv'],
    ]);
    const [unnamed] = groupByInstitution([{ ...sampleCsvAccount, institution_name: null }]);
    expect(unnamed?.name).toBe('Imported CSV');
  });
});

describe('removalWords', () => {
  it('unlinks a linked bank, which can be linked again', () => {
    expect(removalWords('plaid')).toEqual({
      verb: 'Unlink',
      done: 'Unlinked',
      again: 'You can link it again later.',
    });
  });

  it('removes an imported account, which can be imported again', () => {
    expect(removalWords('csv')).toEqual({
      verb: 'Remove',
      done: 'Removed',
      again: 'You can import the file again later.',
    });
  });
});

describe('transactionCountText', () => {
  it.each([
    [{ transaction_count: 16, first_posted_at: '2026-10-01' }, '16 transactions since Oct 2026'],
    [{ transaction_count: 1, first_posted_at: '2026-07-04' }, '1 transaction since Jul 2026'],
    // The API counts them all: never "200+" (spec 002 rule 30a).
    [
      { transaction_count: 1_205, first_posted_at: '2025-08-01' },
      '1,205 transactions since Aug 2025',
    ],
    [{ transaction_count: 0, first_posted_at: null }, 'No transactions yet'],
  ])('%j reads %s', (count, text) => {
    expect(transactionCountText(count)).toBe(text);
  });
});

describe('ownedText', () => {
  it('names what unlinking deletes', () => {
    expect(ownedText(1)).toBe('Its account and its transactions');
    expect(ownedText(2)).toBe('Its 2 accounts and their transactions');
  });
});
