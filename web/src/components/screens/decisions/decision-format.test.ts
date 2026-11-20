import { describe, expect, it } from 'vitest';
import { ResultMismatch } from '@/lib/api/hooks';
import { parseMoney } from '@/lib/money';
import { cappedK401, sampleDecision, sampleK401 } from '@/test/fixtures/decisions';
import { sampleW4Event } from '@/test/fixtures/w4';
import {
  amountText,
  calendarNote,
  examplePlaceholder,
  matchHeadline,
  readAmount,
  reviewChanges,
  salaryQuestionText,
  saveBadgeTone,
  saveErrorText,
  tiersText,
} from './decision-format';
import { MAX_PERIOD_CENTS } from '@/lib/entry-limits';

const apiError = (code: string, message = 'The API said no') => ({ error: { code, message } });

describe('readAmount and amountText', () => {
  const example = '300.00';
  const max = MAX_PERIOD_CENTS;

  it('reads an amount as cents, the way it is typed', () => {
    expect(readAmount('$1,823.25', { example, max })).toEqual({ cents: 182_325, error: null });
    expect(readAmount(' 300 ', { example, max })).toEqual({ cents: 30_000, error: null });
    expect(readAmount('0', { example, max })).toEqual({ cents: 0, error: null });
    expect(readAmount('1,000,000.00', { example, max })).toEqual({ cents: max, error: null });
  });

  it('is nothing yet when empty', () => {
    expect(readAmount('  ', { example, max })).toEqual({ cents: null, error: null });
  });

  // Spec 018 rule 5e and its table: the message names the actual problem (issue 238).
  it.each([
    ['lots', 'Enter an amount, like 300.00.'],
    ['12.', 'Enter an amount, like 300.00.'],
    ['1,23', 'Enter an amount, like 300.00.'],
    ['1.234', 'Enter at most two digits after the decimal point, like 300.00.'],
    ['1,234.567', 'Enter at most two digits after the decimal point, like 300.00.'],
    ['-5', 'Enter an amount from $0 to $1,000,000.00.'],
    ['1,000,000.01', 'Enter an amount from $0 to $1,000,000.00.'],
    ['99999999999999', 'Enter an amount from $0 to $1,000,000.00.'],
    ['999999999999999999999', 'Enter an amount from $0 to $1,000,000.00.'],
  ])('says what is wrong with %j', (text, error) => {
    expect(readAmount(text, { example, max })).toEqual({ cents: null, error });
  });

  it('names a range above $0 for an amount the calculator needs above zero', () => {
    const essentials = { example: '1,823.25', max, positive: true };
    for (const text of ['0', '0.00', '-1', '99999999999999']) {
      expect(readAmount(text, essentials)).toEqual({
        cents: null,
        error: 'Enter an amount above $0 and up to $1,000,000.00.',
      });
    }
    expect(readAmount('1,234.567', essentials).error).toBe(
      'Enter at most two digits after the decimal point, like 1,823.25.',
    );
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
    expect(saveErrorText(mismatch)).toMatch(/^Your numbers changed after they were shown/);
  });

  it('explains a conflict, a missing plan choice, and passes other messages on', () => {
    expect(saveErrorText(apiError('decision_conflict'))).toMatch(/saved in another tab or window/);
    expect(saveErrorText(apiError('plan_not_selected'))).toBe(
      'Choose the plan you will enroll in, then save.',
    );
    expect(
      saveErrorText(
        apiError('validation_error', 'We do not have the federal tax figures for 2027 yet'),
      ),
    ).toBe('We do not have the federal tax figures for 2027 yet');
    // A field path is for developers (spec 008 rule 22a): the card's own sentence instead.
    expect(saveErrorText(apiError('validation_error', 'inputs.tax_year: Field required'))).toBe(
      'Could not save this decision. Try again.',
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

  it('warns while a saved decision needs review (spec 018 rule 5c)', () => {
    expect(saveBadgeTone('review')).toBe('warning');
  });
});

describe('reviewChanges (spec 018 rule 5c)', () => {
  const schedule = {
    kind: 'changed' as const,
    input: 'pay_periods_per_year' as const,
    text: 'Your pay schedule changed from 26 to 24 paychecks a year.',
  };
  const question = {
    kind: 'salary_unconfirmed' as const,
    input: 'salary_cents' as const,
    text: 'Your newest pay stub comes to $64,999.92 a year, not the $95,000.10 in your plan details. Choose which salary to use.',
  };

  it("says when the decision was saved and lists the API's words for what changed", () => {
    const decision = sampleDecision({
      created_at: '2026-10-21T15:00:00Z',
      review: [schedule, question],
    });
    expect(reviewChanges(decision)).toEqual({
      since: 'Since you saved this on Oct 21, 2026:',
      changes: [schedule.text],
    });
  });

  it('is null when nothing changed: an open salary question is asked on its own', () => {
    expect(reviewChanges(sampleDecision())).toBeNull();
    expect(reviewChanges(sampleDecision({ review: [question] }))).toBeNull();
  });
});

describe('salaryQuestionText (spec 018 rule 5d)', () => {
  it("issue 221's account: the Acme stub against the saved $95,000.10", () => {
    expect(
      salaryQuestionText({
        pay_stub_id: 'stub-acme',
        pay_stub_date: '2026-10-15',
        frequency: 'semimonthly',
        periods_per_year: 24,
        gross_cents: 270_833,
        annual_salary_cents: 6_499_992,
        salary_cents: 9_500_010,
      }),
    ).toEqual({
      lead: 'Your Oct 15, 2026 pay stub pays $2,708.33 twice a month, which comes to $64,999.92 a year. The salary in your plan details is $95,000.10.',
      use: 'Use $64,999.92',
      keep: 'Keep $95,000.10',
    });
  });

  it('names each schedule as a person says it', () => {
    const question = {
      pay_stub_id: 'stub-01',
      pay_stub_date: '2026-04-10',
      frequency: 'biweekly' as const,
      periods_per_year: 26 as const,
      gross_cents: 365_385,
      annual_salary_cents: 9_500_010,
      salary_cents: 6_500_000,
    };
    expect(salaryQuestionText(question).lead).toBe(
      'Your Apr 10, 2026 pay stub pays $3,653.85 every two weeks, which comes to $95,000.10 a year. The salary in your plan details is $65,000.00.',
    );
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
