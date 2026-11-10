import { describe, expect, it } from 'vitest';
import { sampleExplanation, sampleFallbackExplanation } from '@/test/fixtures/decisions';
import { explanationState, isExplained, sentenceCase } from './explanations';

describe('isExplained', () => {
  it('is true for the calculators the API explains, never for the emergency fund', () => {
    expect(isExplained('k401_match')).toBe(true);
    expect(isExplained('health_plans')).toBe(true);
    expect(isExplained('w4')).toBe(true);
    // Spec 011 rule 18: no tax rule applies, so there is nothing to explain or cite.
    expect(isExplained('emergency_fund')).toBe(false);
  });
});

describe('sentenceCase (spec 008 rule 19d, issue 243)', () => {
  it('capitalizes a lowercase first letter and changes nothing else', () => {
    expect(sentenceCase('rate you chose')).toBe('Rate you chose');
    expect(sentenceCase("acme's match per year")).toBe("Acme's match per year");
    expect(sentenceCase('Your marginal rate')).toBe('Your marginal rate');
  });

  it('leaves a label that starts with a name or a figure as it is', () => {
    expect(sentenceCase('401(k) rate on your pay stub now')).toBe(
      '401(k) rate on your pay stub now',
    );
    expect(sentenceCase('W-4 entries per paycheck')).toBe('W-4 entries per paycheck');
    expect(sentenceCase('$2,600 match')).toBe('$2,600 match');
    expect(sentenceCase('')).toBe('');
  });
});

describe('explanationState (spec 008 rule 19c, issue 227)', () => {
  it('reads a verified, a stale, a fallback and a missing explanation', () => {
    expect(explanationState(sampleExplanation())).toBe('current');
    expect(explanationState(sampleExplanation({ stale: true }))).toBe('stale');
    expect(explanationState(sampleFallbackExplanation())).toBe('fallback');
    expect(explanationState(sampleFallbackExplanation({ stale: true }))).toBe('fallback');
    expect(explanationState(null)).toBe('none');
  });
});
