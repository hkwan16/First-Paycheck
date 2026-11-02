import { describe, expect, it } from 'vitest';
import type { Decision, DecisionList } from './api/types';
import { sampleEmergencyFund, sampleHealthPlans } from '@/test/fixtures/planning';
import { sampleW4, sampleW4Inputs } from '@/test/fixtures/w4';
import {
  ageAtYearEnd,
  asEmergencyFundInputs,
  asEmergencyFundResult,
  asHealthPlansInputs,
  asK401Inputs,
  asK401Result,
  asW4Inputs,
  calculatorIdOf,
  CALCULATOR_KINDS,
  currentDecision,
  decisionSaveState,
  percentInput,
} from './decisions';
import { CALCULATORS } from './features';

const inputs = {
  salary_cents: 6_500_000,
  pay_periods_per_year: 24,
  match_tiers: [{ employee_pct_upto: '4.00', employer_pct: '100.00' }],
  contribution_pct: '4.00',
  tax_year: 2026,
  filing_status: 'single',
  age: 30,
};

const result = {
  full_match_pct: '4.00',
  employer_match_cents_current: 260_000,
  employer_match_cents_full: 260_000,
  missed_cents: 0,
  employee_annual_cents_current: 260_000,
  employee_annual_cents_full: 260_000,
  per_paycheck_cost_delta_cents: 0,
  per_paycheck_after_tax_cost_cents: 0,
  marginal_rate_used: '12.00',
  deferral_limit_cents: 2_450_000,
  capped: false,
  compensation_capped: false,
  citation_keys: ['k401.employer_match'],
};

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: 'dec-1',
    calculator: 'k401_match',
    version: 1,
    supersedes_id: null,
    check_in_id: null,
    inputs,
    result,
    created_at: '2026-10-20T19:12:00Z',
    is_current: true,
    ...overrides,
  };
}

describe('decisionSaveState (spec 018 rules 5a and 5b)', () => {
  it('nothing saved yet', () => {
    expect(decisionSaveState(undefined, inputs)).toEqual({
      status: 'unsaved',
      action: 'Save',
      label: 'Not saved',
    });
    expect(decisionSaveState(null, inputs).status).toBe('unsaved');
  });

  it('the saved inputs, whatever their key order', () => {
    const reordered = Object.fromEntries(Object.entries(inputs).reverse());
    expect(decisionSaveState(decision({ version: 2 }), reordered)).toEqual({
      status: 'saved',
      action: 'Saved',
      label: 'Saved Oct 20',
    });
  });

  it('other inputs: changes to save, and no version in the words', () => {
    expect(decisionSaveState(decision(), { ...inputs, contribution_pct: '5.00' })).toEqual({
      status: 'dirty',
      action: 'Save changes',
      label: 'Changes not saved',
    });
    const tiers = [{ employee_pct_upto: '4.00', employer_pct: '50.00' }];
    expect(decisionSaveState(decision({ version: 3 }), { ...inputs, match_tiers: tiers })).toEqual({
      status: 'dirty',
      action: 'Save changes',
      label: 'Changes not saved',
    });
  });

  it('compares canonical values exactly: "4" is not the saved "4.00"', () => {
    expect(decisionSaveState(decision(), { ...inputs, contribution_pct: '4' }).status).toBe(
      'dirty',
    );
  });

  it('cannot be saved before there are inputs to save', () => {
    expect(decisionSaveState(decision(), null).status).toBe('dirty');
    expect(decisionSaveState(undefined, null).status).toBe('unsaved');
  });

  it('ignores what describes, not decides: on either side and absent or not', () => {
    const ignore = ['age'];
    expect(decisionSaveState(decision(), { ...inputs, age: 31 }, { ignore }).status).toBe('saved');
    const { age: _age, ...withoutAge } = inputs;
    expect(decisionSaveState(decision({ inputs: withoutAge }), inputs, { ignore }).status).toBe(
      'saved',
    );
    expect(
      decisionSaveState(decision(), { ...inputs, age: 31, tax_year: 2027 }, { ignore }).status,
    ).toBe('dirty');
    expect(decisionSaveState(decision(), { ...inputs, age: 31 }).status).toBe('dirty');
  });
});

describe('calculator ids', () => {
  it('maps every feature flag id to an API calculator and back', () => {
    for (const id of CALCULATORS) {
      expect(calculatorIdOf(CALCULATOR_KINDS[id])).toBe(id);
    }
    expect(CALCULATOR_KINDS['401k_match']).toBe('k401_match');
    expect(CALCULATOR_KINDS.health_plan).toBe('health_plans');
  });
});

describe('currentDecision', () => {
  it("finds a calculator's current decision in GET /decisions", () => {
    const list: DecisionList = {
      items: [
        {
          calculator: 'k401_match',
          current: decision({ id: 'dec-2', version: 2 }),
          versions: [],
        },
      ],
    };
    expect(currentDecision(list, 'k401_match')?.id).toBe('dec-2');
    expect(currentDecision(list, 'w4')).toBeUndefined();
    expect(currentDecision(undefined, 'k401_match')).toBeUndefined();
  });
});

describe('percentInput', () => {
  it('writes a whole slider value the way the API stores a percentage', () => {
    expect(percentInput(0)).toBe('0.00');
    expect(percentInput(4)).toBe('4.00');
    expect(percentInput(15)).toBe('15.00');
  });
});

describe('asK401Inputs and asK401Result', () => {
  it("read a saved decision's stored inputs and result", () => {
    expect(asK401Inputs(inputs)).toEqual(inputs);
    expect(asK401Result(result)).toEqual(result);
  });

  it('refuse objects that are not the 401(k) shapes', () => {
    expect(asK401Inputs({ ...inputs, salary_cents: '6500000' })).toBeNull();
    expect(asK401Inputs({ months: 3 })).toBeNull();
    expect(asK401Result({ ...result, missed_cents: undefined })).toBeNull();
    expect(asK401Result({ ...result, capped: 'no' })).toBeNull();
  });
});

describe('asEmergencyFundInputs and asHealthPlansInputs', () => {
  it("read a saved decision's stored inputs", () => {
    const fund = sampleEmergencyFund().inputs;
    const plans = sampleHealthPlans({ selected_plan_index: 1 }).inputs;
    expect(asEmergencyFundInputs({ ...fund })).toEqual(fund);
    expect(asHealthPlansInputs(structuredClone(plans) as never)).toEqual(plans);
  });

  it('refuse objects that are not those shapes', () => {
    const fund = sampleEmergencyFund().inputs;
    const plans = sampleHealthPlans().inputs;
    expect(asEmergencyFundInputs({ ...fund, target_months: '3' })).toBeNull();
    expect(asEmergencyFundInputs(inputs)).toBeNull();
    expect(asHealthPlansInputs({ ...plans, plans: [{ name: 'Gold PPO' }] } as never)).toBeNull();
    expect(asHealthPlansInputs({ ...plans, expected_usage: 'some' } as never)).toBeNull();
    expect(asHealthPlansInputs(inputs)).toBeNull();
  });
});

describe('asEmergencyFundResult', () => {
  it("reads a saved decision's stored result, and refuses another shape", () => {
    const { result } = sampleEmergencyFund();
    expect(asEmergencyFundResult({ ...result })).toEqual(result);
    expect(asEmergencyFundResult({ ...result, months_to_target: null })).not.toBeNull();
    expect(asEmergencyFundResult({ ...result, funded_pct: 39.12 })).toBeNull();
    expect(asEmergencyFundResult({ ...result, months_to_target: '12' })).toBeNull();
    expect(asEmergencyFundResult(inputs)).toBeNull();
  });
});

describe('asW4Inputs', () => {
  it("reads a saved W-4 decision's stored inputs, with or without the optional ones set", () => {
    const stored = sampleW4().inputs;
    expect(asW4Inputs({ ...stored })).toEqual(stored);
    const set = sampleW4Inputs({
      multiple_jobs: true,
      deductions_cents: 1_752_200,
      expected_deductions_cents: 0,
      age: null,
    });
    expect(asW4Inputs({ ...set })).toEqual(set);
    const noStub = sampleW4Inputs({ current_withholding_per_paycheck_cents: null });
    expect(asW4Inputs({ ...noStub })).toEqual(noStub);
  });

  it('reads a decision saved before the stub comparison, which has no such input', () => {
    const { current_withholding_per_paycheck_cents: _current, ...older } = sampleW4().inputs;
    expect(asW4Inputs({ ...older })).toEqual(older);
    expect(asW4Inputs({ ...older, current_withholding_per_paycheck_cents: '272.44' })).toBeNull();
  });

  it('refuses objects that are not that shape', () => {
    const stored = sampleW4().inputs;
    expect(asW4Inputs({ ...stored, multiple_jobs: 'no' })).toBeNull();
    expect(asW4Inputs({ ...stored, extra_withholding_cents: '100' })).toBeNull();
    expect(asW4Inputs({ ...stored, k401_contribution_pct: 4 })).toBeNull();
    expect(asW4Inputs({ ...stored, filing_status: 'married' })).toBeNull();
    expect(asW4Inputs({ ...stored, expected_deductions_cents: undefined })).toBeNull();
    expect(asW4Inputs(inputs)).toBeNull();
  });
});

describe('ageAtYearEnd', () => {
  // The 401(k) calculator wants the age reached by December 31 of the tax year (spec 006).
  it('is the tax year less the birth year', () => {
    expect(ageAtYearEnd(2026, 1996)).toBe(30);
    expect(ageAtYearEnd(2026, 1976)).toBe(50);
  });

  it('is null without a birth year, or one after the tax year', () => {
    expect(ageAtYearEnd(2026, null)).toBeNull();
    expect(ageAtYearEnd(2026, undefined)).toBeNull();
    expect(ageAtYearEnd(2026, 2027)).toBeNull();
  });
});
