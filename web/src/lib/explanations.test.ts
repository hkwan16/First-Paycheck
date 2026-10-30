import { describe, expect, it } from 'vitest';
import { isExplained } from './explanations';

describe('isExplained', () => {
  it('is true for the calculators the API explains, never for the emergency fund', () => {
    expect(isExplained('k401_match')).toBe(true);
    expect(isExplained('health_plans')).toBe(true);
    expect(isExplained('w4')).toBe(true);
    // Spec 011 rule 18: no tax rule applies, so there is nothing to explain or cite.
    expect(isExplained('emergency_fund')).toBe(false);
  });
});
