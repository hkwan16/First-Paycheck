import { describe, expect, it } from 'vitest';
import { sampleTransactions } from '@/test/fixtures/sample';
import { countSources, monthName, periodText, sourceBadge } from './spending-format';

const txn = sampleTransactions[0]!;

describe('sourceBadge', () => {
  it('shows a fix by the person as confirmed', () => {
    expect(sourceBadge({ ...txn, category_source: 'user', confidence: null })).toEqual({
      tone: 'confirmed',
      text: 'You',
    });
  });

  it('shows an AI label with its confidence, as a warning under 70%', () => {
    expect(sourceBadge({ ...txn, category_source: 'llm', confidence: 0.91 })).toEqual({
      tone: 'blue',
      text: 'AI · 91%',
    });
    expect(sourceBadge({ ...txn, category_source: 'llm', confidence: 0.7 })).toEqual({
      tone: 'blue',
      text: 'AI · 70%',
    });
    expect(sourceBadge({ ...txn, category_source: 'llm', confidence: 0.62 })).toEqual({
      tone: 'warning',
      text: 'AI · 62%',
    });
    expect(sourceBadge({ ...txn, category_source: 'llm', confidence: null })).toEqual({
      tone: 'blue',
      text: 'AI',
    });
  });

  it('shows rules as neutral, and says when nothing has labeled it yet', () => {
    expect(sourceBadge({ ...txn, category_source: 'rule' })).toEqual({
      tone: 'neutral',
      text: 'Rule',
    });
    expect(sourceBadge({ ...txn, category: null, category_source: null })).toEqual({
      tone: 'neutral',
      text: 'Not labeled',
    });
  });
});

describe('countSources', () => {
  it('counts the loaded rows by who labeled them', () => {
    expect(countSources(sampleTransactions)).toEqual({ rule: 11, llm: 4, user: 1 });
    expect(countSources([])).toEqual({ rule: 0, llm: 0, user: 0 });
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
