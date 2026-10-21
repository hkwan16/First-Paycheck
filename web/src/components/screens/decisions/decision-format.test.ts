import { describe, expect, it } from 'vitest';
import { cappedK401, sampleK401 } from '@/test/fixtures/decisions';
import { matchHeadline, saveBadgeTone, tiersText } from './decision-format';

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
