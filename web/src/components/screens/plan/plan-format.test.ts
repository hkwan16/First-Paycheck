import { describe, expect, it } from 'vitest';
import type { PlanFigure } from '@/lib/api/types';
import { samplePlan } from '@/test/fixtures/plan';
import {
  completenessText,
  eventHue,
  explanationView,
  figureText,
  goalLabel,
  payFrequencyLabel,
} from './plan-format';

const fig = (
  kind: PlanFigure['kind'],
  value: PlanFigure['value'],
  key = 'result.x',
): PlanFigure => ({
  key,
  label: 'X',
  kind,
  value,
});

describe('figureText', () => {
  it('formats each kind of figure exactly as the API sent it', () => {
    expect(figureText(fig('money', 546_975))).toBe('$5,469.75');
    expect(figureText(fig('money', -12_345))).toBe('-$123.45');
    expect(figureText(fig('percent', '39.12'))).toBe('39.12%');
    expect(figureText(fig('percent', '4.00'))).toBe('4%');
    expect(figureText(fig('count', 12))).toBe('12');
    expect(figureText(fig('text', 'Gold PPO'))).toBe('Gold PPO');
  });

  it('says an emergency fund out of reach is not within 10 years, and other gaps are not set', () => {
    expect(figureText(fig('count', null, 'result.months_to_target'))).toBe('Not within 10 years');
    expect(figureText(fig('money', null))).toBe('Not set');
  });

  it('refuses a value of the wrong type rather than guessing', () => {
    expect(() => figureText(fig('money', '12'))).toThrow(TypeError);
    expect(() => figureText(fig('percent', 4))).toThrow(TypeError);
  });

  it('formats every figure of the sample plan', () => {
    for (const decision of samplePlan().decisions) {
      for (const figure of decision.figures) expect(figureText(figure)).not.toBe('');
    }
  });
});

describe('explanationView', () => {
  it('reads the status, and an emergency fund is never explained', () => {
    const [fund, k401, health, w4] = samplePlan().decisions;
    expect(explanationView(fund!)).toBe('unavailable');
    expect(explanationView(k401!)).toBe('verified');
    expect(explanationView(health!)).toBe('fallback');
    expect(explanationView(w4!)).toBe('none');
  });
});

describe('completenessText', () => {
  it('counts the saved calculators against all of them', () => {
    expect(completenessText(samplePlan().completeness)).toBe('4 of 4 decisions saved');
    expect(
      completenessText({
        saved: ['k401_match'],
        missing: ['emergency_fund', 'health_plans', 'w4'],
      }),
    ).toBe('1 of 4 decisions saved');
  });
});

describe('goalLabel', () => {
  it('names each kind of goal', () => {
    expect(goalLabel('emergency_fund')).toBe('Emergency fund');
    expect(goalLabel('custom')).toBe('Savings goal');
  });
});

describe('eventHue', () => {
  it('takes the hue of the decision an event belongs to, else neutral', () => {
    const plan = samplePlan();
    const hues = plan.calendar.map((event) => eventHue(event, plan.decisions));
    expect(hues).toEqual(['plum', 'teal', 'blue', 'coral']);
    expect(eventHue({ ...plan.calendar[0]!, decision_id: null }, plan.decisions)).toBe('neutral');
  });
});

describe('payFrequencyLabel', () => {
  it('names each pay schedule, and none', () => {
    expect(payFrequencyLabel('semimonthly')).toBe('Semi-monthly');
    expect(payFrequencyLabel('biweekly')).toBe('Every two weeks');
    expect(payFrequencyLabel('weekly')).toBe('Weekly');
    expect(payFrequencyLabel('monthly')).toBe('Monthly');
    expect(payFrequencyLabel(null)).toBeNull();
  });
});
