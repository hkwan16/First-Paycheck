import { describe, expect, it } from 'vitest';
import { sampleAccounts } from '@/test/fixtures/sample';
import {
  groupByInstitution,
  institutionInitials,
  patchForRole,
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
    [null, '?'],
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
