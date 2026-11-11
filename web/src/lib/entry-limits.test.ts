import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  latestBirthYear,
  MAX_BALANCE_CENTS,
  MAX_PERIOD_CENTS,
  MAX_STEP3_CREDITS_CENTS,
  MAX_YEARLY_CENTS,
  MIN_BIRTH_YEAR,
} from './entry-limits';

/** The API's own contract, read the way `pnpm gen:api` reads it. */
const openapi = JSON.parse(readFileSync(resolve(process.cwd(), '../api/openapi.json'), 'utf8'));

interface PropertySchema {
  type?: string;
  maximum?: number;
  minimum?: number;
  anyOf?: PropertySchema[];
}

/** A property's schema, the non-null branch of an optional one. */
function property(schema: string, field: string): PropertySchema {
  const found: PropertySchema | undefined = openapi.components.schemas[schema]?.properties?.[field];
  if (!found) throw new Error(`api/openapi.json has no ${schema}.${field}`);
  return found.anyOf?.find((branch) => branch.type !== 'null') ?? found;
}

describe('the entry limits the decision forms mirror (spec 007 rule 2a, spec 018 rule 5e)', () => {
  // Every amount a form checks before it sends, against the field it is sent as.
  const mirrored: [schema: string, field: string, maximum: number][] = [
    ['EmergencyFundInput', 'monthly_essentials_cents', MAX_PERIOD_CENTS],
    ['EmergencyFundInput', 'current_balance_cents', MAX_BALANCE_CENTS],
    ['EmergencyFundInput', 'monthly_contribution_cents', MAX_PERIOD_CENTS],
    ['GoalPatch', 'monthly_contribution_cents', MAX_PERIOD_CENTS],
    ['ProfileIn', 'salary_cents', MAX_YEARLY_CENTS],
    ['K401MatchInput', 'salary_cents', MAX_YEARLY_CENTS],
    ['HealthPlansInput', 'salary_cents', MAX_YEARLY_CENTS],
    ['HealthPlansInput', 'employee_hsa_cents', MAX_YEARLY_CENTS],
    ['HealthPlanOption', 'premium_per_period_cents', MAX_PERIOD_CENTS],
    ['HealthPlanOption', 'deductible_cents', MAX_YEARLY_CENTS],
    ['HealthPlanOption', 'oop_max_cents', MAX_YEARLY_CENTS],
    // The year's HSA limit is the API's alone (spec 012 rule 18b); the form checks the type's.
    ['HealthPlanOption', 'employer_hsa_cents', MAX_BALANCE_CENTS],
    ['W4Input', 'salary_cents', MAX_YEARLY_CENTS],
    ['W4Input', 'other_jobs_wages_cents', MAX_YEARLY_CENTS],
    ['W4Input', 'other_jobs_withholding_cents', MAX_YEARLY_CENTS],
    ['W4Input', 'dependents_credit_cents', MAX_STEP3_CREDITS_CENTS],
    ['W4Input', 'other_income_cents', MAX_YEARLY_CENTS],
    ['W4Input', 'deductions_cents', MAX_YEARLY_CENTS],
    ['W4Input', 'extra_withholding_cents', MAX_PERIOD_CENTS],
    ['W4Input', 'expected_deductions_cents', MAX_YEARLY_CENTS],
  ];

  it.each(mirrored)("%s.%s is the API's maximum", (schema, field, maximum) => {
    expect(property(schema, field).maximum).toBe(maximum);
  });

  it("starts birth years where the API's profile does", () => {
    expect(property('ProfileIn', 'birth_year').minimum).toBe(MIN_BIRTH_YEAR);
  });

  it('ends birth years at someone 14 this year, as PUT /profile does', () => {
    expect(latestBirthYear(2026)).toBe(2012);
    expect(latestBirthYear(2027)).toBe(2013);
  });
});
