import { describe, expect, it } from 'vitest';
import {
  confidenceBadge,
  fieldDisplay,
  FIELD_CHOICES,
  PAY_FREQUENCY_CHOICES,
  redactionParts,
  splitSourceLine,
} from './field-format';

describe('fieldDisplay', () => {
  it('formats each kind of value for reading', () => {
    expect(fieldDisplay({ kind: 'money', value: 270_833 }, false)).toBe('$2,708.33');
    expect(fieldDisplay({ kind: 'money', value: 0 }, false)).toBe('$0.00');
    expect(fieldDisplay({ kind: 'date', value: '2026-10-15' }, false)).toBe('Oct 15, 2026');
    expect(fieldDisplay({ kind: 'text', value: 'Acme Corp' }, false)).toBe('Acme Corp');
    expect(fieldDisplay({ kind: 'percent', value: '20.00' }, false)).toBe('20.00%');
    expect(
      fieldDisplay({ kind: 'text', value: 'semimonthly', choices: PAY_FREQUENCY_CHOICES }, false),
    ).toBe('Twice a month');
  });

  it('says a value is missing in the words of each mode', () => {
    expect(fieldDisplay({ kind: 'text', value: null }, false)).toBe('None');
    expect(fieldDisplay({ kind: 'money', value: null }, true)).toBe('Not entered yet');
  });
});

describe('confidenceBadge', () => {
  it('asks for a check below 0.9 and says "Read" otherwise', () => {
    expect(confidenceBadge(0.74, false)).toEqual({ label: 'Check · 74%', tone: 'warning' });
    expect(confidenceBadge(0.899, false)).toEqual({ label: 'Check · 90%', tone: 'warning' });
    expect(confidenceBadge(0.9, false)).toEqual({ label: 'Read · 90%', tone: 'blue' });
    expect(confidenceBadge(0.99, false)).toEqual({ label: 'Read · 99%', tone: 'blue' });
  });

  it('marks a computed field, and shows nothing for typed fields', () => {
    expect(confidenceBadge(null, false)).toEqual({ label: 'Added up', tone: 'neutral' });
    expect(confidenceBadge(null, true)).toBeNull();
  });
});

describe('PAY_FREQUENCY_CHOICES', () => {
  it("offers every pay frequency the API accepts, and is the pay_frequency field's choices", () => {
    expect(PAY_FREQUENCY_CHOICES.map((c) => c.value)).toEqual([
      'weekly',
      'biweekly',
      'semimonthly',
      'monthly',
    ]);
    expect(FIELD_CHOICES.pay_frequency).toBe(PAY_FREQUENCY_CHOICES);
  });
});

describe('splitSourceLine', () => {
  it('puts a trailing amount on the right, like the printed stub', () => {
    expect(splitSourceLine('GROSS PAY 2,708.33')).toEqual({
      label: 'GROSS PAY',
      value: '2,708.33',
    });
    expect(splitSourceLine('401K EE -')).toEqual({ label: '401K EE', value: '-' });
    expect(splitSourceLine('NET   $1,996.04')).toEqual({ label: 'NET', value: '$1,996.04' });
  });

  it('splits on a wide gap, and keeps other lines whole', () => {
    expect(splitSourceLine('PAY FREQ    SEMI-MONTHLY')).toEqual({
      label: 'PAY FREQ',
      value: 'SEMI-MONTHLY',
    });
    expect(splitSourceLine('ACME CORP EARNINGS STATEMENT')).toEqual({
      label: 'ACME CORP EARNINGS STATEMENT',
      value: null,
    });
    expect(splitSourceLine('SSN [REDACTED]')).toEqual({ label: 'SSN', value: '[REDACTED]' });
    expect(splitSourceLine('DEPOSIT ACCT [REDACTED]4821')).toEqual({
      label: 'DEPOSIT ACCT',
      value: '[REDACTED]4821',
    });
  });
});

describe('redactionParts', () => {
  it('splits text around each redaction mark', () => {
    expect(redactionParts('[REDACTED]4821')).toEqual([
      { redacted: true, text: '' },
      { redacted: false, text: '4821' },
    ]);
    expect(redactionParts('a [REDACTED] b [REDACTED]')).toEqual([
      { redacted: false, text: 'a ' },
      { redacted: true, text: '' },
      { redacted: false, text: ' b ' },
      { redacted: true, text: '' },
    ]);
    expect(redactionParts('plain')).toEqual([{ redacted: false, text: 'plain' }]);
  });
});
