import { describe, expect, it } from 'vitest';
import { ACCOUNT_KIND_LABELS, institutionName, maskLabel } from './accounts';

describe('maskLabel', () => {
  it('prefixes the last digits with two middle dots, as the mockup does', () => {
    expect(maskLabel('4821')).toBe('··4821');
    expect(maskLabel(null)).toBeNull();
    expect(maskLabel('')).toBeNull();
  });
});

describe('institutionName', () => {
  it.each([
    ['plaid', 'Chase', 'Chase'],
    ['csv', 'Credit union', 'Credit union'],
    ['plaid', null, 'Linked bank'],
    ['csv', null, 'Imported CSV'],
    ['plaid', '  ', 'Linked bank'],
    ['csv', '', 'Imported CSV'],
  ] as const)('a %s account named %j is %j', (provider, name, expected) => {
    expect(institutionName({ provider, institution_name: name })).toBe(expected);
  });
});

describe('ACCOUNT_KIND_LABELS', () => {
  it('names every kind the API sends, a loan as a loan', () => {
    expect(ACCOUNT_KIND_LABELS).toEqual({
      checking: 'Checking',
      savings: 'Savings',
      credit: 'Credit card',
      loan: 'Loan',
      investment: 'Investment',
      retirement: 'Retirement',
    });
  });
});
