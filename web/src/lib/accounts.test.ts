import { describe, expect, it } from 'vitest';
import { ACCOUNT_KIND_LABELS, maskLabel } from './accounts';

describe('maskLabel', () => {
  it('prefixes the last digits with two middle dots, as the mockup does', () => {
    expect(maskLabel('4821')).toBe('··4821');
    expect(maskLabel(null)).toBeNull();
    expect(maskLabel('')).toBeNull();
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
