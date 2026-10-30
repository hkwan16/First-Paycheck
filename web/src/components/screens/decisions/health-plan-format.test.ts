import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PlanPair } from '@/lib/api/types';
import {
  BRONZE_HSA,
  ENROLLMENT_DEADLINE,
  GOLD_PPO,
  sampleBenefitsPlans,
  sampleHealthPlans,
  SAVER_HDHP,
  SILVER_HMO,
} from '@/test/fixtures/planning';
import {
  costAt,
  costText,
  draftFromOption,
  EMPTY_PLAN_DRAFT,
  hdhpNotice,
  headline,
  hsaEffect,
  MAX_PLANS,
  pairText,
  plansFromBenefits,
  readPlanDrafts,
  USAGE_DEFAULTS,
  usageLabel,
} from './health-plan-format';

/** The API's own contract, read the way `pnpm gen:api` reads it. */
const openapi = JSON.parse(readFileSync(resolve(process.cwd(), '../api/openapi.json'), 'utf8'));

describe('the calculator constants the card sends', () => {
  it("match the API's defaults and plan limit", () => {
    const input = openapi.components.schemas.HealthPlansInput.properties;
    expect(USAGE_DEFAULTS).toEqual({
      low: input.usage_low_cents.default,
      medium: input.usage_medium_cents.default,
      high: input.usage_high_cents.default,
    });
    expect(MAX_PLANS).toBe(input.plans.maxItems);
  });
});

describe('usageLabel', () => {
  it('names a usage scenario with its yearly spending', () => {
    expect(usageLabel('low', 50_000)).toBe('Low · about $500');
    expect(usageLabel('high', 1_000_000)).toBe('High · about $10,000');
    expect(usageLabel('medium', 300_000, { row: true })).toBe('Medium use · about $3,000');
  });
});

describe('plansFromBenefits', () => {
  it("takes the newest summary's plans, in its order, with its enrollment deadline", () => {
    const older = { ...sampleBenefitsPlans[0]!, id: 'old', document_id: 'older-doc', name: 'Old' };
    expect(plansFromBenefits([...sampleBenefitsPlans, older])).toEqual({
      plans: [BRONZE_HSA, GOLD_PPO, SAVER_HDHP],
      deadline: ENROLLMENT_DEADLINE,
      left: 0,
    });
  });

  it('keeps at most the plans the calculator takes, and says how many were left', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      ...sampleBenefitsPlans[1]!,
      id: `p${i}`,
      name: `Plan ${i + 1}`,
      enrollment_deadline: null,
    }));
    const { plans, deadline, left } = plansFromBenefits(many)!;
    expect(plans).toHaveLength(MAX_PLANS);
    expect(left).toBe(2);
    expect(deadline).toBeNull();
  });

  it('is null without confirmed plans', () => {
    expect(plansFromBenefits([])).toBeNull();
    expect(plansFromBenefits(undefined)).toBeNull();
  });
});

describe('costAt', () => {
  it("picks the plan's cost at a usage scenario", () => {
    const [bronze] = sampleHealthPlans().result.plans;
    expect(costAt(bronze!, 'low')).toBe(65_000);
    expect(costAt(bronze!, 'medium')).toBe(219_000);
    expect(costAt(bronze!, 'high')).toBe(359_000);
  });
});

describe('costText', () => {
  it("writes the API's net cost in whole dollars, a negative one as an amount ahead", () => {
    const { result } = sampleHealthPlans({ expected_usage: 'low' });
    const [bronze, , saver] = result.plans;
    expect(costText(bronze!.low_cost_cents)).toBe('$650');
    expect(costText(saver!.low_cost_cents)).toBe('$260 ahead');
    expect(costText(saver!.worst_case_cents)).toBe('$5,740');
    expect(costText(-30_000)).toBe('$300 ahead');
  });
});

describe('headline', () => {
  it('names the cheapest plan at the expected usage and its yearly cost', () => {
    expect(headline(sampleHealthPlans().result, 'medium')).toBe(
      'Gold PPO costs the least at medium use: $2,025 a year',
    );
    expect(headline(sampleHealthPlans({ expected_usage: 'high' }).result, 'high')).toBe(
      'Gold PPO costs the least at high use: $2,725 a year',
    );
  });

  it('says a cheapest plan that comes out ahead leaves you that much ahead (spec 012 rule 17)', () => {
    const { result } = sampleHealthPlans({ expected_usage: 'low' });
    // The API's sign: Saver HDHP's low cost is negative.
    expect(result.plans[2]!.low_cost_cents).toBe(-26_000);
    expect(headline(result, 'low')).toBe(
      'Saver HDHP costs the least at low use and leaves you $260 ahead a year',
    );
  });
});

describe('pairText', () => {
  const names = ['Bronze HSA', 'Gold PPO', 'Silver HMO'];
  const pair = (overrides: Partial<PlanPair>): PlanPair => ({
    plan_a_index: 0,
    plan_b_index: 1,
    cheaper_at_zero_index: 0,
    break_even_spends_cents: [],
    cheaper_at_end_index: 0,
    ...overrides,
  });

  it('reads where the cheaper plan changes, as the API scanned it', () => {
    expect(pairText(sampleHealthPlans().result.pairs[0]!, names)).toBe(
      'With no care, Bronze HSA costs less. The cheaper plan changes at $1,800 and $19,300 of care a year. Once both reach their out-of-pocket maximums, Bronze HSA costs less.',
    );
    expect(
      pairText(
        pair({
          plan_b_index: 2,
          break_even_spends_cents: [450_000, 460_000, 900_000],
          cheaper_at_end_index: 2,
        }),
        names,
      ),
    ).toBe(
      'With no care, Bronze HSA costs less. The cheaper plan changes at $4,500, $4,600 and $9,000 of care a year. Once both reach their out-of-pocket maximums, Silver HMO costs less.',
    );
  });

  it('says when one plan costs less throughout, or the two never differ', () => {
    expect(
      pairText(
        pair({
          plan_a_index: 1,
          plan_b_index: 2,
          cheaper_at_zero_index: 2,
          cheaper_at_end_index: 2,
        }),
        names,
      ),
    ).toBe('Silver HMO costs less than Gold PPO at any amount of care.');
    expect(pairText(pair({ cheaper_at_zero_index: null, cheaper_at_end_index: null }), names)).toBe(
      'Bronze HSA and Gold PPO cost the same at any amount of care.',
    );
  });

  it('says when they tie at either end', () => {
    expect(
      pairText(
        pair({
          cheaper_at_zero_index: null,
          break_even_spends_cents: [10_000],
          cheaper_at_end_index: null,
        }),
        names,
      ),
    ).toBe(
      'With no care, Bronze HSA and Gold PPO cost the same. The cheaper plan changes at $100 of care a year. Once both reach their out-of-pocket maximums, they cost the same.',
    );
  });
});

describe('hsaEffect', () => {
  it('says what an HSA contribution saves in federal income tax', () => {
    const { result } = sampleHealthPlans({ employee_hsa_cents: 100_000 });
    expect(hsaEffect(result.plans[0]!, result)).toBe(
      'With Bronze HSA, putting $1,000.00 into your HSA saves $120.00 in federal income tax at your 12% marginal rate.',
    );
  });

  it('says when the contribution was capped by the limit', () => {
    const { result } = sampleHealthPlans({ employee_hsa_cents: 500_000 });
    expect(hsaEffect(result.plans[0]!, result)).toBe(
      "With Bronze HSA, your HSA contribution is capped at $3,800.00, so that it and the employer's $600.00 stay within the $4,400.00 limit. It saves $456.00 in federal income tax at your 12% marginal rate.",
    );
  });

  it('invites a contribution when none is planned, and says nothing for a plan without an HSA', () => {
    const { result } = sampleHealthPlans();
    expect(hsaEffect(result.plans[0]!, result)).toBe(
      'Bronze HSA lets you put money into an HSA before tax. Enter what you plan to put in to see what it saves.',
    );
    expect(hsaEffect(result.plans[1]!, result)).toBeNull();
  });
});

describe('hdhpNotice', () => {
  it('names a plan labeled high-deductible that misses the HSA rules', () => {
    const { result } = sampleHealthPlans({
      plans: [{ ...BRONZE_HSA, deductible_cents: 150_000 }, GOLD_PPO, SAVER_HDHP],
      employee_hsa_cents: 100_000,
    });
    expect(hdhpNotice(result.plans[0]!, result, 2026)).toBe(
      'Bronze HSA is labeled a high-deductible plan but does not meet the 2026 HSA rules (a deductible of at least $1,700 and an out-of-pocket maximum of at most $8,500), so you cannot put money into an HSA with it.',
    );
    expect(hdhpNotice(result.plans[1]!, result, 2026)).toBeNull();
    expect(hdhpNotice(sampleHealthPlans().result.plans[0]!, result, 2026)).toBeNull();
  });
});

describe('plan drafts', () => {
  it('start from a plan the way a person would type it', () => {
    expect(draftFromOption(BRONZE_HSA)).toEqual({
      name: 'Bronze HSA',
      kind: 'hdhp',
      premium: '31.25',
      deductible: '1,800.00',
      coinsurance: '20',
      oopMax: '3,500.00',
      employerHsa: '600.00',
    });
  });

  it('read as the calculator takes them, percentages in the stored form', () => {
    expect(
      readPlanDrafts([
        {
          name: ' Silver HMO ',
          kind: 'hmo',
          premium: '40',
          deductible: '1,000',
          coinsurance: '0',
          oopMax: '2,500',
          employerHsa: '',
        },
      ]),
    ).toEqual({ ok: true, plans: [SILVER_HMO] });
  });

  it('send no employer HSA money with a plan that is not high-deductible', () => {
    const read = readPlanDrafts([{ ...draftFromOption(GOLD_PPO), employerHsa: '500' }]);
    expect(read).toEqual({ ok: true, plans: [GOLD_PPO] });
  });

  it('say what to fix in each plan', () => {
    expect(
      readPlanDrafts([
        { ...EMPTY_PLAN_DRAFT },
        { ...draftFromOption(BRONZE_HSA), coinsurance: '120', employerHsa: 'x' },
      ]),
    ).toEqual({
      ok: false,
      errors: [
        {
          name: 'Enter the plan name.',
          kind: 'Choose the plan type.',
          premium: 'Enter an amount, like 62.50.',
          deductible: 'Enter an amount, like 250.00.',
          coinsurance: 'Enter a percentage from 0 to 100, like 20.',
          oopMax: 'Enter an amount, like 3,000.00.',
        },
        {
          coinsurance: 'Enter a percentage from 0 to 100, like 20.',
          employerHsa: 'Enter an amount, like 600.00.',
        },
      ],
    });
  });
});
