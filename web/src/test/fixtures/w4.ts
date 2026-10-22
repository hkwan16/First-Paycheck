import type { CalendarEvent, Decision, W4Input, W4Result } from '@/lib/api/types';
import { deepEqual } from '@/lib/deep-equal';
import { SAMPLE_SAVED_AT } from './decisions';
import cases from './w4-results.json';

/*
 * The M7 sample: J. Rivera's Form W-4 ($65,000.00, semi-monthly, single,
 * 2026, 30 by the end of the year) with the sample's saved 401(k) decision
 * (4%) and health plan decision (the Gold PPO, $62.50 a paycheck) as inputs.
 * Every result was computed by the API's own calculator (w4-results.json,
 * written by make-w4-results.py); nothing is worked out in TypeScript.
 * Invented data only.
 */

export interface W4Case {
  inputs: W4Input;
  result: W4Result;
}

export const w4Cases = cases as unknown as readonly W4Case[];

/** The API's W-4 result for these inputs, if w4-results.json has the case. */
export const w4Result = (inputs: unknown) =>
  w4Cases.find((c) => deepEqual(c.inputs, inputs))?.result;

/**
 * The card's inputs for the sample: the saved 401(k) and health plan
 * decisions read in, and nothing entered on the form yet.
 */
export function sampleW4Inputs(overrides: Partial<W4Input> = {}): W4Input {
  return {
    salary_cents: 6_500_000,
    pay_periods_per_year: 24,
    filing_status: 'single',
    tax_year: 2026,
    k401_contribution_pct: '4.00',
    age: 30,
    health_premium_per_paycheck_cents: 6_250,
    multiple_jobs: false,
    dependents_credit_cents: 0,
    other_income_cents: 0,
    deductions_cents: 0,
    extra_withholding_cents: 0,
    expected_deductions_cents: null,
    other_jobs_wages_cents: 0,
    other_jobs_withholding_cents: 0,
    ...overrides,
  };
}

/** The same with neither decision saved: no 401(k) deferral and no premium. */
export const NO_DECISIONS: Partial<W4Input> = {
  k401_contribution_pct: '0.00',
  health_premium_per_paycheck_cents: 0,
};

/** The sample at these inputs, with the API's result. */
export function sampleW4(overrides: Partial<W4Input> = {}): W4Case {
  const inputs = sampleW4Inputs(overrides);
  const result = w4Result(inputs);
  if (!result) throw new Error(`w4-results.json has no case for ${JSON.stringify(inputs)}`);
  return { inputs, result };
}

export const W4_DECISION_ID = 'dec00000-0000-4000-8000-0000000000f1';

/** The sample's W-4 decision: version 1, nothing entered beyond the saved decisions. */
export function sampleW4Decision(overrides: Partial<Decision> = {}): Decision {
  const { inputs, result } = sampleW4();
  return {
    id: W4_DECISION_ID,
    calculator: 'w4',
    version: 1,
    supersedes_id: null,
    check_in_id: null,
    inputs: { ...inputs },
    result: structuredClone(result),
    created_at: SAMPLE_SAVED_AT,
    is_current: true,
    ...overrides,
  };
}

/** The reminder a saved W-4 decision adds for the next pay date (spec 014 rule 18). */
export function sampleW4Event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'ca000000-0000-4000-8000-0000000000f1',
    kind: 'w4_submit',
    title: 'Give your employer your updated Form W-4',
    due_at: '2026-10-31',
    decision_id: W4_DECISION_ID,
    status: 'upcoming',
    ...overrides,
  };
}
