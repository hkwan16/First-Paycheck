import { describe, expect, it } from 'vitest';
import {
  fieldDisplay,
  fieldNote,
  FIELD_CHOICES,
  PAY_FREQUENCY_CHOICES,
  redactionParts,
  splitSourceLine,
  valueBadge,
} from './field-format';

describe('fieldDisplay', () => {
  it('formats each kind of value for reading', () => {
    expect(fieldDisplay({ kind: 'money', value: 270_833 }, false)).toBe('$2,708.33');
    expect(fieldDisplay({ kind: 'money', value: 0 }, false)).toBe('$0.00');
    expect(fieldDisplay({ kind: 'date', value: '2026-10-15' }, false)).toBe('Oct 15, 2026');
    expect(fieldDisplay({ kind: 'text', value: 'Acme Corp' }, false)).toBe('Acme Corp');
    expect(fieldDisplay({ kind: 'percent', value: '20.00' }, false)).toBe('20%');
    expect(fieldDisplay({ kind: 'percent', value: '12.50' }, false)).toBe('12.5%');
    expect(fieldDisplay({ kind: 'number', value: 3 }, false)).toBe('3');
    expect(
      fieldDisplay(
        { kind: 'number', value: 3, choices: [{ value: '3', label: '3 years' }] },
        false,
      ),
    ).toBe('3 years');
    expect(
      fieldDisplay({ kind: 'text', value: 'semimonthly', choices: PAY_FREQUENCY_CHOICES }, false),
    ).toBe('Twice a month');
  });

  it('says a value is missing in the words of each mode', () => {
    // Not "None", which reads as zero (issue 195).
    expect(fieldDisplay({ kind: 'text', value: null }, false)).toBe('Not found');
    expect(fieldDisplay({ kind: 'money', value: null }, true)).toBe('Not entered yet');
  });
});

/** A money deduction as read: 401(k) contribution at the given confidence and value. */
const deduction = (
  value: number | null,
  confidence: number | null = 0.97,
  proposed: number | null = value,
) => ({
  kind: 'money' as const,
  role: 'deduction' as const,
  value,
  proposed,
  confidence,
  note: value === null ? 'Type it if the document shows it.' : null,
});

describe('valueBadge', () => {
  it('asks for a check below 0.9 and says it read clearly otherwise, with no score', () => {
    expect(valueBadge(deduction(100, 0.74), false)).toEqual({
      label: 'Check this',
      tone: 'warning',
    });
    expect(valueBadge(deduction(100, 0.899), false)).toEqual({
      label: 'Check this',
      tone: 'warning',
    });
    expect(valueBadge(deduction(100, 0.9), false)).toEqual({ label: 'Read clearly', tone: 'blue' });
    expect(valueBadge(deduction(100, 0.99), false)).toEqual({
      label: 'Read clearly',
      tone: 'blue',
    });
  });

  it('marks a computed field, and shows nothing for typed fields', () => {
    expect(valueBadge(deduction(4_670, null), false)).toEqual({
      label: 'Added up',
      tone: 'neutral',
    });
    expect(valueBadge(deduction(4_670, null, null), true)).toBeNull();
  });

  it('never says a field nothing was read for was read clearly (issue 230)', () => {
    expect(valueBadge(deduction(null, 0.97), false)).toEqual({
      label: 'Check this',
      tone: 'warning',
    });
  });

  it('labels a value the person typed or confirmed as none as theirs (issue 230)', () => {
    expect(valueBadge(deduction(0, 0.97, null), false)).toEqual({
      label: 'Your entry',
      tone: 'neutral',
    });
    expect(valueBadge(deduction(270_834, 0.99, 270_833), false)).toEqual({
      label: 'Your entry',
      tone: 'neutral',
    });
    expect(valueBadge(deduction(4_000, null, 4_670), false)).toEqual({
      label: 'Your entry',
      tone: 'neutral',
    });
  });
});

describe('fieldNote', () => {
  it("keeps the proposal's note for a value as read", () => {
    expect(fieldNote({ ...deduction(4_670, null), note: 'From CA SDI' }, false)).toBe(
      'From CA SDI',
    );
  });

  it('says how to confirm a deduction the stub does not print as none (issue 230)', () => {
    expect(fieldNote(deduction(null), false)).toBe('If your stub has no such line, confirm none.');
    expect(fieldNote(deduction(null), true)).toBe('Leave it empty if your stub has no such line.');
  });

  it('keeps the note for a missing field that cannot be none', () => {
    expect(fieldNote({ ...deduction(null), role: 'gross' }, false)).toBe(
      'Type it if the document shows it.',
    );
  });

  it('drops the note once the person entered the value', () => {
    expect(fieldNote(deduction(0, 0.97, null), false)).toBeNull();
    expect(fieldNote({ ...deduction(4_000, null, 4_670), note: 'From CA SDI' }, false)).toBeNull();
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
