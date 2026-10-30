import { describe, expect, it } from 'vitest';
import type { Proposal } from '@/lib/api/types';
import {
  BRONZE_HSA,
  ENROLLMENT_DEADLINE,
  GOLD_PPO,
  SAVER_HDHP,
  sampleBenefitsProposal,
} from '@/test/fixtures/planning';
import { benefitsValues, initBenefitsState, reviewSections } from './benefits-fields';
import {
  confirmReducer,
  mathGate,
  parseDraft,
  summarize,
  type ConfirmAction,
  type ConfirmState,
} from './confirmReducer';

const run = (state: ConfirmState, ...actions: ConfirmAction[]) =>
  actions.reduce(confirmReducer, state);

const field = (state: ConfirmState, key: string) => {
  const found = state.fields.find((f) => f.key === key);
  if (!found) throw new Error(`no field ${key}`);
  return found;
};

const proposal = (overrides: Partial<Proposal> = {}): Proposal => ({
  ...structuredClone(sampleBenefitsProposal),
  ...overrides,
});

describe('initBenefitsState', () => {
  it('gives every plan, tier and the vesting field a key of its own, in the proposal order', () => {
    const state = initBenefitsState(proposal());
    expect(state.fields.map((f) => f.key)).toEqual([
      ...[0, 1, 2].flatMap((i) =>
        [
          'name',
          'kind',
          'premium_per_period_cents',
          'deductible_cents',
          'oop_max_cents',
          'coinsurance_pct',
          'employer_hsa_cents',
          'enrollment_deadline',
        ].map((key) => `plans.${i}.${key}`),
      ),
      'match_tiers.0.employee_pct_upto',
      'match_tiers.0.employer_pct',
      'match_tiers.1.employee_pct_upto',
      'match_tiers.1.employer_pct',
      'vesting_years',
    ]);
    expect(state.selected).toBe('plans.0.name');
    expect(state.fields.every((f) => !f.confirmed && f.draft === null)).toBe(true);
  });

  it('keeps the labels, confidence and notes, and names each group', () => {
    const state = initBenefitsState(proposal());
    expect(field(state, 'plans.1.coinsurance_pct')).toMatchObject({
      label: 'Coinsurance',
      group: 'Plan 2',
      confidence: 0.82,
      value: '10.00',
    });
    expect(field(state, 'match_tiers.1.employee_pct_upto')).toMatchObject({
      group: 'Tier 2',
      note: 'Cumulative: 2.00% added to the tiers before it',
    });
    expect(field(state, 'vesting_years')).toMatchObject({ value: 3, confidence: 0.88 });
    expect(field(state, 'vesting_years').group).toBeUndefined();
  });

  it('offers the plan types and vesting years as choices', () => {
    const state = initBenefitsState(proposal());
    expect(field(state, 'plans.0.kind').choices?.map((c) => c.value)).toEqual([
      'hdhp',
      'ppo',
      'hmo',
    ]);
    const years = field(state, 'vesting_years').choices ?? [];
    expect(years.map((c) => c.value)).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
    ]);
    expect(years[0]?.label).toBe('Immediately');
    expect(years[3]?.label).toBe('3 years');
  });

  it('leaves out the vesting field when the summary describes no match', () => {
    const state = initBenefitsState(proposal({ match_tiers: [] }));
    expect(state.fields.some((f) => f.key === 'vesting_years')).toBe(false);
  });
});

describe('the benefits review in confirmReducer', () => {
  it('needs a value for every field the API requires before confirming it', () => {
    const missing = proposal();
    missing.match_tiers![1]!.fields[0]!.value = null;
    missing.plans![0]!.fields[7]!.value = null;
    const state = run(
      initBenefitsState(missing),
      { type: 'toggle', key: 'match_tiers.1.employee_pct_upto' },
      { type: 'toggle', key: 'plans.0.enrollment_deadline' },
    );
    expect(field(state, 'match_tiers.1.employee_pct_upto')).toMatchObject({
      confirmed: false,
      draft: '',
      error: 'Enter a percentage, like 20 or 12.5',
    });
    // An enrollment deadline is optional: a plan may not print one.
    expect(field(state, 'plans.0.enrollment_deadline')).toMatchObject({
      confirmed: true,
      value: null,
    });
  });

  it('confirm all leaves a missing required value for the person to type', () => {
    const missing = proposal();
    missing.plans![1]!.fields[0]!.value = null;
    const state = run(initBenefitsState(missing), { type: 'confirmAll' });
    expect(field(state, 'plans.1.name').confirmed).toBe(false);
    expect(summarize(state)).toMatchObject({ remaining: 1, canContinue: false });
  });

  it('refuses a plan type or vesting years outside the choices', () => {
    const state = initBenefitsState(proposal());
    expect(parseDraft(field(state, 'plans.0.kind'), 'pos')).toEqual({
      ok: false,
      error: 'Choose one of the options',
    });
    expect(parseDraft(field(state, 'vesting_years'), '2.5')).toEqual({
      ok: false,
      error: 'Choose one of the options',
    });
    expect(parseDraft(field(state, 'vesting_years'), '5')).toEqual({ ok: true, value: 5 });
  });

  it('has nothing to add up, so continuing needs only every field confirmed', () => {
    const state = run(initBenefitsState(proposal()), { type: 'confirmAll' });
    expect(mathGate(state.fields)).toEqual({ status: 'none' });
    expect(summarize(state)).toMatchObject({ remaining: 0, canContinue: true });
  });
});

describe('reviewSections', () => {
  it('groups the fields into plans, tiers and vesting for the screen', () => {
    const sections = reviewSections(initBenefitsState(proposal()).fields);
    expect(sections.plans.map((plan) => [plan.title, plan.fields.length])).toEqual([
      ['Plan 1: Bronze HSA', 8],
      ['Plan 2: Gold PPO', 8],
      ['Plan 3: Saver HDHP', 8],
    ]);
    expect(sections.tiers.map((tier) => [tier.title, tier.fields.length])).toEqual([
      ['Tier 1', 2],
      ['Tier 2', 2],
    ]);
    expect(sections.vesting?.key).toBe('vesting_years');
  });
});

describe('benefitsValues', () => {
  it('sends the confirmed plans and the 401(k) match with vesting', () => {
    const state = run(initBenefitsState(proposal()), { type: 'confirmAll' });
    expect(benefitsValues(state.fields)).toEqual({
      plans: [BRONZE_HSA, GOLD_PPO, SAVER_HDHP].map((plan) => ({
        ...plan,
        enrollment_deadline: ENROLLMENT_DEADLINE,
      })),
      retirement: {
        match_tiers: [
          { employee_pct_upto: '3.00', employer_pct: '100.00' },
          { employee_pct_upto: '5.00', employer_pct: '50.00' },
        ],
        vesting_years: 3,
      },
    });
  });

  it('sends no retirement part when the summary describes no match, so the profile keeps its own', () => {
    const state = run(initBenefitsState(proposal({ match_tiers: [] })), { type: 'confirmAll' });
    expect(benefitsValues(state.fields).retirement).toBeNull();
  });

  it('sends an employer HSA amount the summary did not print as 0, as the API stores it', () => {
    const unprinted = proposal();
    unprinted.plans![1]!.fields[6]!.value = null;
    const state = run(initBenefitsState(unprinted), { type: 'confirmAll' });
    expect(benefitsValues(state.fields).plans[1]).toMatchObject({ employer_hsa_cents: 0 });
  });
});
