import type { CalculatorKind, Explanation } from './api/types';

/**
 * Calculators the API explains (`api/retrieval/context.py:BENEFITS_QUERIES`).
 * An emergency fund is arithmetic on the person's own spending and savings
 * with no tax rule behind it, so there is nothing to explain or cite (spec 011
 * rule 18): no surface offers to write one.
 */
const EXPLAINED: ReadonlySet<CalculatorKind> = new Set(['k401_match', 'health_plans', 'w4']);

export const isExplained = (calculator: CalculatorKind): boolean => EXPLAINED.has(calculator);

/**
 * A label in sentence case (spec 008 rule 19d, issue 243): a lowercase first
 * letter becomes a capital and nothing else changes, so a label the model wrote
 * as "rate you chose" reads like "401(k) rate on your pay stub" and "W-4 entries".
 */
export const sentenceCase = (label: string): string =>
  label.replace(/^\p{Ll}/u, (first) => first.toUpperCase());

/**
 * What state a decision's latest explanation is in (spec 008 rules 19a and
 * 19c): checked and current, checked but written from information that has
 * changed since, one that could not be written (stale or not), or none (`null`,
 * the API's 404).
 */
export type ExplanationState = 'current' | 'stale' | 'fallback' | 'none';

export function explanationState(explanation: Explanation | null): ExplanationState {
  if (!explanation) return 'none';
  if (!explanation.verified) return 'fallback';
  return explanation.stale ? 'stale' : 'current';
}
