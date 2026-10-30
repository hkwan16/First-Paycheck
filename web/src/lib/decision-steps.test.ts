import { describe, expect, it } from 'vitest';
import {
  DECISION_STEPS,
  firstLiveStep,
  lastLiveStep,
  liveNeighbors,
  STEP_TEXT,
  stepNumber,
} from './decision-steps';
import { CALCULATORS, type CalculatorId } from './features';

const ALL: readonly CalculatorId[] = CALCULATORS;
const ALPHA: readonly CalculatorId[] = ['401k_match'];

describe('DECISION_STEPS (spec 018 rule 1)', () => {
  it("keeps the mockup's order, the W-4 last because it reads the 401(k) and health plan", () => {
    expect(DECISION_STEPS).toEqual(['emergency_fund', '401k_match', 'health_plan', 'w4']);
  });

  it('covers every calculator once', () => {
    expect([...DECISION_STEPS].sort()).toEqual([...CALCULATORS].sort());
  });

  it('numbers the steps from 1 in that order, live or not', () => {
    expect(DECISION_STEPS.map(stepNumber)).toEqual([1, 2, 3, 4]);
  });

  it('names each step for its heading, tab, nav and footer', () => {
    expect(STEP_TEXT).toEqual({
      emergency_fund: {
        title: 'How much to keep for emergencies',
        label: 'Emergency fund',
        name: 'emergency fund',
      },
      '401k_match': {
        title: 'How much to put in your 401(k)',
        label: '401(k) match',
        name: '401(k) match',
      },
      health_plan: {
        title: 'Which health plan to choose',
        label: 'Health plan',
        name: 'health plan',
      },
      w4: { title: 'What to put on your W-4', label: 'W-4', name: 'W-4' },
    });
  });
});

describe('liveNeighbors (spec 018 rule 6)', () => {
  it.each([
    ['every live: the first step goes back to Spending', ALL, 'emergency_fund', null, '401k_match'],
    ['every live: a middle step', ALL, 'health_plan', '401k_match', 'w4'],
    ['every live: the last step goes on to the plan', ALL, 'w4', 'health_plan', null],
    ['the alpha: the 401(k) is the only step', ALPHA, '401k_match', null, null],
    [
      'the alpha: a placeholder step has the live steps around it',
      ALPHA,
      'health_plan',
      '401k_match',
      null,
    ],
    [
      'skips a step in the middle that is not live',
      ['emergency_fund', 'w4'],
      'emergency_fund',
      null,
      'w4',
    ],
  ] as const)('%s', (_name, live, step, previous, next) => {
    expect(liveNeighbors(step, live)).toEqual({ previous, next });
  });

  it('gives every step no neighbors when nothing is live', () => {
    for (const step of DECISION_STEPS) {
      expect(liveNeighbors(step, [])).toEqual({ previous: null, next: null });
    }
  });
});

describe('firstLiveStep and lastLiveStep (spec 018 rule 3)', () => {
  it.each([
    ['every live', ALL, 'emergency_fund', 'w4'],
    ['the alpha', ALPHA, '401k_match', '401k_match'],
    ['none live', [], 'emergency_fund', 'w4'],
    ['live in another order', ['w4', 'health_plan'], 'health_plan', 'w4'],
  ] as const)('%s', (_name, live, first, last) => {
    expect(firstLiveStep(live)).toBe(first);
    expect(lastLiveStep(live)).toBe(last);
  });
});
