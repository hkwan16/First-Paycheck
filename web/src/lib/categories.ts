import type { SwatchColor } from '@/components/ui/Swatch';
import type { Category } from '@/lib/api/types';

/*
 * Category labels and their spending buckets.
 *
 * TODO(GET /spending/summary, M5): the API will return the category-to-bucket
 * mapping with the summary (technical spec amendment 16). Replace BUCKETS'
 * membership below with that mapping and keep only the labels here. The ids
 * are the API's `Category` enum; categories.test.ts fails when the schema
 * gains one this file does not know.
 */

export type Bucket = 'income' | 'essentials' | 'flexible' | 'savings' | 'other';

export interface BucketInfo {
  label: string;
  /** The bucket's hue: plum income, blue essentials, coral flexible, teal savings. */
  swatch: SwatchColor;
}

export const BUCKETS: Record<Bucket, BucketInfo> = {
  income: { label: 'Income', swatch: 'plum' },
  essentials: { label: 'Essentials', swatch: 'blue' },
  flexible: { label: 'Flexible', swatch: 'coral' },
  savings: { label: 'Savings', swatch: 'teal' },
  other: { label: 'Not spending', swatch: 'flow-tax' },
};

const BUCKET_ORDER: readonly Bucket[] = ['income', 'essentials', 'flexible', 'savings', 'other'];

export interface CategoryInfo {
  label: string;
  bucket: Bucket;
}

export const CATEGORIES: Record<Category, CategoryInfo> = {
  income: { label: 'Income', bucket: 'income' },
  housing: { label: 'Housing', bucket: 'essentials' },
  groceries: { label: 'Groceries', bucket: 'essentials' },
  utilities: { label: 'Utilities', bucket: 'essentials' },
  phone_internet: { label: 'Phone and internet', bucket: 'essentials' },
  transport: { label: 'Transport', bucket: 'essentials' },
  insurance: { label: 'Insurance', bucket: 'essentials' },
  healthcare: { label: 'Healthcare', bucket: 'essentials' },
  dining: { label: 'Dining', bucket: 'flexible' },
  shopping: { label: 'Shopping', bucket: 'flexible' },
  subscriptions: { label: 'Subscriptions', bucket: 'flexible' },
  entertainment: { label: 'Entertainment', bucket: 'flexible' },
  travel: { label: 'Travel', bucket: 'flexible' },
  personal_care: { label: 'Personal care', bucket: 'flexible' },
  education: { label: 'Education', bucket: 'flexible' },
  gifts_donations: { label: 'Gifts and donations', bucket: 'flexible' },
  savings_investment: { label: 'Savings transfer', bucket: 'savings' },
  transfer: { label: 'Transfer between accounts', bucket: 'other' },
  debt_payment: { label: 'Debt payment', bucket: 'other' },
  fees: { label: 'Fees', bucket: 'other' },
  taxes: { label: 'Taxes', bucket: 'other' },
  other: { label: 'Other', bucket: 'other' },
};

export function categoryInfo(category: Category): CategoryInfo {
  return CATEGORIES[category];
}

export interface CategoryGroup {
  bucket: Bucket;
  label: string;
  categories: { id: Category; label: string }[];
}

/** Categories grouped by bucket, in bucket order, for the category select's optgroups. */
export function categoryGroups(): CategoryGroup[] {
  const entries = Object.entries(CATEGORIES) as [Category, CategoryInfo][];
  return BUCKET_ORDER.map((bucket) => ({
    bucket,
    label: BUCKETS[bucket].label,
    categories: entries
      .filter(([, info]) => info.bucket === bucket)
      .map(([id, info]) => ({ id, label: info.label })),
  }));
}
