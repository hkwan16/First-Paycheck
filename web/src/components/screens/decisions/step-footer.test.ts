import { describe, expect, it } from 'vitest';
import { CALCULATORS } from '@/lib/features';
import { stepFooter } from './step-footer';

describe('stepFooter (spec 018 rule 6)', () => {
  it.each([
    [
      'every live: the first step goes back to Spending',
      CALCULATORS,
      'emergency_fund',
      { href: '/setup/spending' },
      { label: 'Next: 401(k) match', href: '/setup/decisions/401k' },
    ],
    [
      'every live: a middle step',
      CALCULATORS,
      'health_plan',
      { href: '/setup/decisions/401k', label: 'Back to 401(k) match' },
      { label: 'Next: W-4', href: '/setup/decisions/w4' },
    ],
    [
      'every live: the last step goes on to the plan',
      CALCULATORS,
      'w4',
      { href: '/setup/decisions/health-plan', label: 'Back to health plan' },
      { label: 'See your plan', href: '/plan' },
    ],
    [
      'the alpha: the 401(k) is the only step',
      ['401k_match'],
      '401k_match',
      { href: '/setup/spending' },
      { label: 'See your plan', href: '/plan' },
    ],
    [
      'the alpha: a placeholder step has the live steps around it',
      ['401k_match'],
      'health_plan',
      { href: '/setup/decisions/401k', label: 'Back to 401(k) match' },
      { label: 'See your plan', href: '/plan' },
    ],
    [
      'skips a step in the middle that is not live',
      ['emergency_fund', 'w4'],
      'emergency_fund',
      { href: '/setup/spending' },
      { label: 'Next: W-4', href: '/setup/decisions/w4' },
    ],
  ] as const)('%s', (_name, live, step, back, next) => {
    expect(stepFooter(step, live)).toEqual({ back, next });
  });

  it('names the emergency fund in lower case mid-sentence', () => {
    expect(stepFooter('401k_match', CALCULATORS).back).toEqual({
      href: '/setup/decisions/emergency-fund',
      label: 'Back to emergency fund',
    });
  });
});
