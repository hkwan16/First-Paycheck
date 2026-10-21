import type { CalculatorId } from '@/lib/features';

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

/** TODO(GET /decisions, M3): wire `useDecisions` to the route. */
export interface DecisionSummary {
  id: string;
  calculator: CalculatorId;
  version: number;
}

export function useDecisions(): DecisionSummary[] | undefined {
  return undefined;
}
