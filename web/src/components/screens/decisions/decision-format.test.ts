import { describe, expect, it } from 'vitest';
import { ResultMismatch } from '@/lib/api/hooks';
import { cappedK401, sampleK401 } from '@/test/fixtures/decisions';
import {
  amountText,
  matchHeadline,
  readAmount,
  saveBadgeTone,
  saveErrorText,
  tiersText,
} from './decision-format';

const apiError = (code: string, message = 'The API said no') => ({ error: { code, message } });

describe('readAmount and amountText', () => {
  const example = '300.00';

  it('reads an amount as cents, the way it is typed', () => {
    expect(readAmount('$1,823.25', { example })).toEqual({ cents: 182_325, error: null });
    expect(readAmount(' 300 ', { example })).toEqual({ cents: 30_000, error: null });
    expect(readAmount('0', { example })).toEqual({ cents: 0, error: null });
  });

  it('is nothing yet when empty, and says what to fix otherwise', () => {
    expect(readAmount('  ', { example })).toEqual({ cents: null, error: null });
    for (const text of ['lots', '-5', '1.234']) {
      expect(readAmount(text, { example })).toEqual({
        cents: null,
        error: 'Enter an amount, like 300.00.',
      });
    }
    expect(readAmount('0', { example: '1,823.25', positive: true })).toEqual({
      cents: null,
      error: 'Enter an amount above $0, like 1,823.25.',
    });
  });

  it('writes cents back the way a person types them', () => {
    expect(amountText(182_325)).toBe('1,823.25');
    expect(amountText(0)).toBe('0.00');
    expect(amountText(null)).toBe('');
  });
});

describe('saveErrorText', () => {
  it('asks to check the refreshed numbers after a result mismatch', () => {
    const mismatch = new ResultMismatch({
      error: { code: 'result_mismatch', message: 'x', details: { fields: ['missed_cents'] } },
    });
    expect(saveErrorText(mismatch)).toMatch(/^The calculator's numbers had changed/);
  });

  it('explains a conflict, a missing plan choice, and passes other messages on', () => {
    expect(saveErrorText(apiError('decision_conflict'))).toMatch(/saved somewhere else/);
    expect(saveErrorText(apiError('plan_not_selected'))).toBe(
      'Choose the plan you will enroll in, then save.',
    );
    expect(saveErrorText(apiError('validation_error', 'tax_year: no constants'))).toBe(
      'tax_year: no constants',
    );
    expect(saveErrorText(new Error('offline'))).toBe('Could not save this decision. Try again.');
  });
});

describe('saveBadgeTone', () => {
  it('is neutral before a save, warning once changed, confirmed when it is the saved version', () => {
    expect(saveBadgeTone('unsaved')).toBe('neutral');
    expect(saveBadgeTone('dirty')).toBe('warning');
    expect(saveBadgeTone('saved')).toBe('confirmed');
  });
});

describe('matchHeadline', () => {
  it('names the whole match when nothing is contributed', () => {
    expect(matchHeadline(sampleK401(0).result)).toBe('You leave the whole $2,600 match behind');
  });

  it('names the part of the match left behind', () => {
    expect(matchHeadline(sampleK401(2).result)).toBe('You leave $1,300 of match behind');
  });

  it('says so when the whole match is captured, at or above the full-match rate', () => {
    expect(matchHeadline(sampleK401(4).result)).toBe('You capture the full $2,600 match');
    expect(matchHeadline(sampleK401(9).result)).toBe('You capture the full $2,600 match');
    expect(matchHeadline(cappedK401.result)).toBe('You capture the full $14,400 match');
  });

  it('says when the plan has no match at all', () => {
    const none = {
      ...sampleK401(0).result,
      employer_match_cents_full: 0,
      employer_match_cents_current: 0,
      missed_cents: 0,
    };
    expect(matchHeadline(none)).toBe('Your plan has no employer match');
  });
});

describe('tiersText', () => {
  it('reads one tier the way the mockup does', () => {
    expect(tiersText([{ employee_pct_upto: '4.00', employer_pct: '100.00' }])).toBe(
      '100% of the first 4%',
    );
  });

  it('reads cumulative tiers in order, without working out their widths', () => {
    expect(
      tiersText([
        { employee_pct_upto: '3.00', employer_pct: '100.00' },
        { employee_pct_upto: '5.00', employer_pct: '50.00' },
      ]),
    ).toBe('100% of the first 3%, then 50% up to 5%');
  });
});
