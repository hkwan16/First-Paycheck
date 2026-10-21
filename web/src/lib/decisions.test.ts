import { describe, expect, it } from 'vitest';
import type { Decision, DecisionList } from './api/types';
import {
  ageAtYearEnd,
  asK401Inputs,
  asK401Result,
  calculatorIdOf,
  CALCULATOR_KINDS,
  currentDecision,
  decisionSaveState,
  payPeriodsFor,
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

describe('decisionSaveState', () => {
  it('is unsaved when the calculator has no decision yet', () => {
    expect(decisionSaveState(undefined, inputs)).toEqual({
      status: 'unsaved',
      version: null,
      action: 'Save this decision',
      label: 'Not saved',
    });
    expect(decisionSaveState(null, inputs).status).toBe('unsaved');
  });

  it('is saved when the inputs are the current version, whatever their key order', () => {
    const reordered = Object.fromEntries(Object.entries(inputs).reverse());
    expect(decisionSaveState(decision({ version: 2 }), reordered)).toEqual({
      status: 'saved',
      version: 2,
      action: 'Saved as v2',
      label: 'Saved v2 · Oct 20',
    });
  });

  it('is dirty with the next version once any input differs from the current one', () => {
    expect(decisionSaveState(decision(), { ...inputs, contribution_pct: '5.00' })).toEqual({
      status: 'dirty',
      version: 1,
      action: 'Save as v2',
      label: 'Changed since v1',
    });
    const tiers = [{ employee_pct_upto: '4.00', employer_pct: '50.00' }];
    expect(decisionSaveState(decision({ version: 3 }), { ...inputs, match_tiers: tiers })).toEqual(
      expect.objectContaining({ status: 'dirty', action: 'Save as v4' }),
    );
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

describe('payPeriodsFor', () => {
  it.each([
    ['weekly', 52],
    ['biweekly', 26],
    ['semimonthly', 24],
    ['monthly', 12],
  ] as const)('%s pay is %i paychecks a year', (frequency, periods) => {
    expect(payPeriodsFor(frequency)).toBe(periods);
  });

  it('is unknown without a frequency', () => {
    expect(payPeriodsFor(null)).toBeNull();
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
