import { describe, expect, it } from 'vitest';
import type { components } from '@/lib/api/schema';
import { CATEGORY_BUCKETS } from '@/test/fixtures/cashflow';
import { BUCKETS, CATEGORIES, categoryGroups, categoryInfo, categoryLabel } from './categories';

type Category = components['schemas']['CategoryPatch']['category'];

// Every value the API's CategoryPatch accepts, spelled out so a new category
// in the schema fails this test until it has a label and a bucket.
const API_CATEGORIES: readonly Category[] = [
  'income',
  'transfer',
  'housing',
  'utilities',
  'phone_internet',
  'groceries',
  'dining',
  'transport',
  'subscriptions',
  'insurance',
  'healthcare',
  'shopping',
  'entertainment',
  'travel',
  'personal_care',
  'education',
  'gifts_donations',
  'cash',
  'fees',
  'taxes',
  'debt_payment',
  'savings_investment',
  'other',
];

describe('categories', () => {
  it('labels every category the API accepts, and nothing else', () => {
    expect(Object.keys(CATEGORIES).sort()).toEqual([...API_CATEGORIES].sort());
    for (const id of API_CATEGORIES) expect(CATEGORIES[id].label).not.toBe('');
  });

  it("puts the mockup's examples in the mockup's buckets", () => {
    expect(categoryInfo('income').bucket).toBe('income');
    for (const id of [
      'housing',
      'groceries',
      'utilities',
      'phone_internet',
      'transport',
    ] as const) {
      expect(categoryInfo(id).bucket).toBe('essentials');
    }
    for (const id of ['dining', 'shopping', 'subscriptions', 'entertainment'] as const) {
      expect(categoryInfo(id).bucket).toBe('flexible');
    }
    expect(categoryInfo('savings_investment').bucket).toBe('savings');
    expect(categoryInfo('transfer').bucket).toBe('transfer');
  });

  it('files cash withdrawn under Flexible, as the API counts it (spec 003 rule 9d, issue 250)', () => {
    expect(categoryInfo('cash')).toEqual({ label: 'Cash', bucket: 'flexible' });
  });

  it("puts every category in the API's bucket, so only a transfer reads as not spending", () => {
    // `CATEGORY_BUCKETS` in api/sync/categories.py, as GET /spending/summary sends it.
    for (const [id, bucket] of Object.entries(CATEGORY_BUCKETS)) {
      expect(categoryInfo(id as Category).bucket, id).toBe(bucket);
    }
    expect(BUCKETS.transfer.label).toBe('Not spending');
    expect(BUCKETS.other.label).toBe('Other spending');
  });

  it('gives each bucket a swatch color: plum income, blue essentials, coral flexible, teal savings', () => {
    expect(BUCKETS.income.swatch).toBe('plum');
    expect(BUCKETS.essentials.swatch).toBe('blue');
    expect(BUCKETS.flexible.swatch).toBe('coral');
    expect(BUCKETS.savings.swatch).toBe('teal');
    expect(BUCKETS.other.swatch).toBe('flow-tax');
    expect(BUCKETS.transfer.swatch).toBe('flow-tax');
  });

  it('groups categories by bucket for the select, each category once', () => {
    const groups = categoryGroups();
    expect(groups.map((g) => g.bucket)).toEqual([
      'income',
      'essentials',
      'flexible',
      'savings',
      'other',
      'transfer',
    ]);
    const ids = groups.flatMap((g) => g.categories.map((c) => c.id));
    expect(ids.sort()).toEqual([...API_CATEGORIES].sort());
  });

  it('labels a category id the API sends as a plain string, readable even when unknown', () => {
    expect(categoryLabel('phone_internet')).toBe('Phone and internet');
    expect(categoryLabel('savings_investment')).toBe('Savings transfer');
    expect(categoryLabel('pet_care')).toBe('Pet care');
  });
});
