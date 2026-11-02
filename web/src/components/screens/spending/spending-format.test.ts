import { describe, expect, it } from 'vitest';
import { sampleTransactions } from '@/test/fixtures/sample';
import {
  ledgerNote,
  monthName,
  NO_SHARE,
  payStubsText,
  periodText,
  shareText,
  sourceBadge,
} from './spending-format';

const txn = sampleTransactions[0]!;

describe('sourceBadge', () => {
  it('shows a fix by the person as confirmed', () => {
    expect(sourceBadge({ ...txn, category_source: 'user', confidence: null })).toEqual({
      tone: 'confirmed',
      text: 'You',
    });
  });

  it('calls a category we read from the name a guess, and asks for a check under 70%', () => {
    expect(sourceBadge({ ...txn, category_source: 'llm', confidence: 0.91 })).toEqual({
      tone: 'blue',
      text: 'Our guess',
    });
    expect(sourceBadge({ ...txn, category_source: 'llm', confidence: 0.7 })).toEqual({
      tone: 'blue',
      text: 'Our guess',
    });
    expect(sourceBadge({ ...txn, category_source: 'llm', confidence: 0.62 })).toEqual({
      tone: 'warning',
      text: 'Guess, check it',
    });
    expect(sourceBadge({ ...txn, category_source: 'llm', confidence: null })).toEqual({
      tone: 'blue',
      text: 'Our guess',
    });
  });

  it('shows a known merchant as neutral, and says when nothing has set a category', () => {
    expect(sourceBadge({ ...txn, category_source: 'rule' })).toEqual({
      tone: 'neutral',
      text: 'Known merchant',
    });
    expect(sourceBadge({ ...txn, category: null, category_source: null })).toEqual({
      tone: 'neutral',
      text: 'No category',
    });
  });
});

describe('periods', () => {
  it('names the month of a calendar date without shifting time zones', () => {
    expect(monthName('2026-10-01')).toBe('October');
  });

  it('reads a period the way the mockup does', () => {
    expect(periodText('2026-10-01', '2026-10-17')).toBe('October 1 to 17');
    expect(periodText('2026-09-28', '2026-10-17')).toBe('September 28 to October 17');
    expect(periodText('2026-12-20', '2027-01-03')).toBe('December 20, 2026 to January 3, 2027');
  });
});

describe('shareText', () => {
  it("words a share of income the API sent, at the caller's precision", () => {
    expect(shareText('45.7', (pct) => `${pct} of income`)).toBe('46% of income');
    expect(shareText('45.7', (pct) => `${pct} of income`, 1)).toBe('45.7% of income');
    // A refund-heavy month's negative share is still a share (spec 007 rule 25).
    expect(shareText('-15.0', (pct) => `Savings rate ${pct}`)).toBe('Savings rate -15%');
  });

  it('says why when the API sent no share', () => {
    expect(NO_SHARE).toBe('Too little income to compare');
    expect(shareText(null, (pct) => `${pct} of income`)).toBe(NO_SHARE);
  });
});

describe('ledgerNote', () => {
  it('says how many loan, investment and retirement transactions the totals left out', () => {
    expect(ledgerNote({ count: 165, net_cents: -5_619_612 })).toBe(
      'Not counted: 165 transactions on loan, investment and retirement accounts. A loan payment counts once, when it leaves checking.',
    );
    expect(ledgerNote({ count: 1, net_cents: 3_500 })).toBe(
      'Not counted: 1 transaction on a loan, investment or retirement account. A loan payment counts once, when it leaves checking.',
    );
  });

  it('says nothing when no row was left out', () => {
    expect(ledgerNote({ count: 0, net_cents: 0 })).toBeNull();
  });
});

describe('payStubsText', () => {
  // Spec 007 rule 26a (issue 164): the count is pay stubs in the period, not paychecks.
  it.each([
    [0, 'no pay stub'],
    [1, '1 pay stub'],
    [2, '2 pay stubs'],
    [1234, '1,234 pay stubs'],
  ])('says %i as "%s"', (count, text) => {
    expect(payStubsText(count)).toBe(text);
  });
});
