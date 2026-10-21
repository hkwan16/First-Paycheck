import type { CalculatorId } from '@/lib/features';
import type { Category } from './types';

/*
 * Reads whose API routes do not exist yet.
 *
 * Each hook has the signature the screen will keep and returns `undefined`,
 * which screens render as a skeleton or an empty state. Each shape is a
 * best guess from docs/technical-spec.md; when the route lands, run
 * `make types`, delete the shape here, read the generated type instead, and
 * replace the body with `$api.useQuery(...).data` under the key reserved in
 * keys.ts. Screens and their tests need no other change.
 */

/** A spending bucket, as the summary groups categories. */
export type SummaryBucket = 'income' | 'essentials' | 'flexible' | 'savings' | 'other';

/**
 * TODO(GET /spending/summary, M5): wire `useSpendingSummary` to the route.
 * Every total is computed by the API (`api/calc/`); the client only formats.
 */
export interface SpendingSummary {
  /** The period summarized, `YYYY-MM-DD` inclusive. */
  start: string;
  end: string;
  /** Pay stubs in the period ("two paychecks"). */
  paycheck_count: number;
  income_cents: number;
  essentials_cents: number;
  flexible_cents: number;
  savings_cents: number;
  /** Take-home not yet spent or moved. */
  left_cents: number;
  /** Percent strings (Decimal), e.g. "38.2". */
  essentials_pct: string;
  flexible_pct: string;
  savings_rate_pct: string;
  /** Transactions still waiting for a category. */
  uncategorized_count: number;
  /** The category-to-bucket mapping (replaces the constant in lib/categories.ts). */
  category_buckets: Record<Category, SummaryBucket>;
}

export function useSpendingSummary(): SpendingSummary | undefined {
  return undefined;
}

/**
 * TODO(GET /docs, M2 documents package): wire `useDocuments` to the route.
 * Uploads (`POST /docs`) and extraction (`POST /docs/{id}/extract`) arrive
 * with the Confirm screen.
 */
export interface DocumentSummary {
  id: string;
  kind: 'pay_stub' | 'offer_letter' | 'benefits';
  filename: string;
  page_count: number | null;
  redaction_count: number | null;
  status: 'uploaded' | 'extracting' | 'extracted' | 'confirmed' | 'failed';
  created_at: string;
}

export function useDocuments(): DocumentSummary[] | undefined {
  return undefined;
}

/** TODO(GET /decisions, M3): wire `useDecisions` to the route. */
export interface DecisionSummary {
  id: string;
  calculator: CalculatorId;
  version: number;
}

export function useDecisions(): DecisionSummary[] | undefined {
  return undefined;
}
