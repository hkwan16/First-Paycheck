import { describe, expect, it } from 'vitest';
import { ResultMismatch } from '@/lib/api/hooks';
import { parseMoney } from '@/lib/money';
import { cappedK401, sampleK401 } from '@/test/fixtures/decisions';
import { sampleW4Event } from '@/test/fixtures/w4';
import {
  amountText,
  calendarNote,
  examplePlaceholder,
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

describe('examplePlaceholder', () => {
  it('reads as an example, never as a value a person could take for theirs', () => {
    expect(examplePlaceholder('65,000.00')).toBe('for example 65,000.00');
    expect(examplePlaceholder('1996')).toBe('for example 1996');
    expect(parseMoney(examplePlaceholder('300.00'))).toBeNull();
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

/** The headline at the sample's rate, with the pay stub showing `payStub`. */
const headline = (pct: number, payStub: string | null) => {
  const { inputs, result } = sampleK401(pct);
  return matchHeadline(result, { chosen: inputs.contribution_pct, payStub });
};

describe('matchHeadline at the rate the pay stub shows (spec 006 rule 14)', () => {
  it('names the whole match when nothing is contributed', () => {
    expect(headline(0, '0.00')).toBe('You leave the whole $2,600 match behind');
  });

  it('names the part of the match left behind', () => {
    expect(headline(2, '2.00')).toBe('You leave $1,300 of match behind');
  });

  it('says so when the whole match is captured, at or above the full-match rate', () => {
    expect(headline(4, '4.00')).toBe('You capture the full $2,600 match');
    expect(headline(9, '9.00')).toBe('You capture the full $2,600 match');
    expect(
      matchHeadline(cappedK401.result, {
        chosen: cappedK401.inputs.contribution_pct,
        payStub: '6.00',
      }),
    ).toBe('You capture the full $14,400 match');
  });

  it('says when the plan has no match at all', () => {
    const none = {
      ...sampleK401(0).result,
      employer_match_cents_full: 0,
      employer_match_cents_current: 0,
      missed_cents: 0,
    };
    expect(matchHeadline(none, { chosen: '0.00', payStub: '0.00' })).toBe(
      'Your plan has no employer match',
    );
    expect(matchHeadline(none, { chosen: '5.00', payStub: '3.00' })).toBe(
      'Your plan has no employer match',
    );
  });
});

describe('matchHeadline at another rate (spec 006 rule 14)', () => {
  it('never says the whole match is left behind by someone the stub shows contributing', () => {
    // Issue 132: the stub shows 3%, and 0% on the slider is only a choice.
    expect(headline(0, '3.00')).toBe('At 0% you would leave the whole $2,600 match behind');
  });

  it('speaks of a chosen rate as a choice until the stub shows it', () => {
    expect(headline(2, '0.00')).toBe('At 2% you would leave $1,300 of match behind');
    expect(headline(4, '0.00')).toBe('At 4% you would capture the full $2,600 match');
    expect(headline(9, '4.00')).toBe('At 9% you would capture the full $2,600 match');
  });

  it('speaks conditionally when the stub has no rate', () => {
    expect(headline(0, null)).toBe('At 0% you would leave the whole $2,600 match behind');
    expect(headline(4, null)).toBe('At 4% you would capture the full $2,600 match');
  });

  it('compares the two-place strings the API sends, digit for digit', () => {
    const { result } = sampleK401(4);
    expect(matchHeadline(result, { chosen: '4.50', payStub: '4.50' })).toBe(
      'You capture the full $2,600 match',
    );
    expect(matchHeadline(result, { chosen: '4.50', payStub: '4.49' })).toBe(
      'At 4.5% you would capture the full $2,600 match',
    );
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

describe('calendarNote (issue 169)', () => {
  it('names the event after its date, so an instruction reads as one', () => {
    expect(calendarNote(sampleW4Event())).toBe(
      'On your calendar for Oct 31, 2026: Give your employer your updated Form W-4.',
    );
  });

  it('reads the same for an event titled with a noun', () => {
    const deadline = sampleW4Event({
      kind: 'enrollment_deadline',
      title: 'Health plan enrollment deadline',
      due_at: '2026-11-14',
    });
    expect(calendarNote(deadline)).toBe(
      'On your calendar for Nov 14, 2026: Health plan enrollment deadline.',
    );
  });
});
