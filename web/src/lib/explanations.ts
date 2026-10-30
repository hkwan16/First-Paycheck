import type { CalculatorKind } from './api/types';

/**
 * Calculators the API explains (`api/retrieval/context.py:BENEFITS_QUERIES`).
 * An emergency fund is arithmetic on the person's own spending and savings
 * with no tax rule behind it, so there is nothing to explain or cite (spec 011
 * rule 18): no surface offers to write one.
 */
const EXPLAINED: ReadonlySet<CalculatorKind> = new Set(['k401_match', 'health_plans', 'w4']);

export const isExplained = (calculator: CalculatorKind): boolean => EXPLAINED.has(calculator);
