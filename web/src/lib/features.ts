/**
 * Feature flags from NEXT_PUBLIC_FEATURES: a comma-separated list of keys.
 *
 *   calculators=<id>+<id>  calculators that are live; the rest render as muted
 *                          "After alpha" placeholders. Unset means all live.
 *   sankey                 show the cash-flow Sankey on the Spending screen.
 *   e2e                    test affordances (sandbox-link button, no devtools).
 *
 * The alpha ships with `calculators=401k_match`.
 */

export const CALCULATORS = ['401k_match', 'emergency_fund', 'health_plan', 'w4'] as const;
export type CalculatorId = (typeof CALCULATORS)[number];

export interface Features {
  calculators: CalculatorId[];
  sankey: boolean;
  e2e: boolean;
}

const isCalculatorId = (id: string): id is CalculatorId =>
  (CALCULATORS as readonly string[]).includes(id);

export function parseFeatures(raw: string | undefined): Features {
  const features: Features = { calculators: [...CALCULATORS], sankey: false, e2e: false };
  for (const entry of (raw ?? '').split(',')) {
    const [key = '', value] = entry.split('=', 2).map((part) => part.trim());
    if (key === 'calculators' && value !== undefined) {
      const ids = value.split('+').map((id) => id.trim());
      features.calculators = [...new Set(ids.filter(isCalculatorId))];
    } else if (key === 'sankey' || key === 'e2e') {
      features[key] = true;
    }
  }
  return features;
}

export function isCalculatorLive(features: Features, id: CalculatorId): boolean {
  return features.calculators.includes(id);
}

/** Flags for this build. `NEXT_PUBLIC_*` is inlined at build time, so it is spelled out here. */
export const features: Features = parseFeatures(process.env.NEXT_PUBLIC_FEATURES);
