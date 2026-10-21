import { describe, expect, it } from 'vitest';
import { CALCULATORS, isCalculatorLive, parseFeatures } from './features';

describe('parseFeatures', () => {
  it('defaults to every calculator live and the optional features off', () => {
    expect(parseFeatures(undefined)).toEqual({
      calculators: [...CALCULATORS],
      sankey: false,
      e2e: false,
    });
    expect(parseFeatures('')).toEqual(parseFeatures(undefined));
  });

  it('limits live calculators to the listed ids (the alpha flag)', () => {
    expect(parseFeatures('calculators=401k_match').calculators).toEqual(['401k_match']);
  });

  it('accepts several calculators joined by +', () => {
    expect(parseFeatures('calculators=401k_match+w4').calculators).toEqual(['401k_match', 'w4']);
  });

  it('treats an empty calculators value as none live', () => {
    expect(parseFeatures('calculators=').calculators).toEqual([]);
  });

  it('turns on bare boolean keys and tolerates spaces', () => {
    expect(parseFeatures(' sankey , e2e ')).toEqual({
      calculators: [...CALCULATORS],
      sankey: true,
      e2e: true,
    });
  });

  it('parses the full alpha string', () => {
    expect(parseFeatures('calculators=401k_match,e2e')).toEqual({
      calculators: ['401k_match'],
      sankey: false,
      e2e: true,
    });
  });

  it('ignores unknown keys and unknown calculator ids', () => {
    expect(parseFeatures('calculators=401k_match+roth,confetti')).toEqual({
      calculators: ['401k_match'],
      sankey: false,
      e2e: false,
    });
  });
});

describe('isCalculatorLive', () => {
  it('reports whether a calculator is enabled', () => {
    const features = parseFeatures('calculators=401k_match');
    expect(isCalculatorLive(features, '401k_match')).toBe(true);
    expect(isCalculatorLive(features, 'w4')).toBe(false);
  });
});
