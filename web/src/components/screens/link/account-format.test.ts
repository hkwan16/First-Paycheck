import { describe, expect, it } from 'vitest';
import { sampleAccounts, sampleCsvAccount } from '@/test/fixtures/sample';
import {
  groupByInstitution,
  institutionInitials,
  ownedText,
  patchForRole,
  removalWords,
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

  it('sends both fields, so "Not used" also clears the role', () => {
    expect(patchForRole('retirement')).toEqual({ role: 'retirement', is_active: true });
    expect(patchForRole('unused')).toEqual({ role: null, is_active: false });
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
    [{ count: 16, more: false, since: '2026-10-01' }, '16 transactions since Oct 2026'],
    [{ count: 1, more: false, since: '2026-07-04' }, '1 transaction since Jul 2026'],
    [{ count: 200, more: true, since: '2026-08-01' }, '200+ transactions'],
    [{ count: 0, more: false, since: null }, 'No transactions yet'],
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
