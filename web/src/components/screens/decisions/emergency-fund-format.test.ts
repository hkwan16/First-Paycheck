import { describe, expect, it } from 'vitest';
import { sampleCashflow } from '@/test/fixtures/cashflow';
import { asEmergencyFundInputs } from '@/lib/decisions';
import { sampleEmergencyDecision, sampleEmergencyFund, sampleGoal } from '@/test/fixtures/planning';
import { sampleAccounts } from '@/test/fixtures/sample';
import {
  accountName,
  emergencyAccount,
  essentialsPrefill,
  fundBarTone,
  fundHeadline,
  goalContributionOf,
  goalPace,
  goalStatusBadge,
  monthsText,
} from './emergency-fund-format';

const result = (overrides: Parameters<typeof sampleEmergencyFund>[0] = {}) =>
  sampleEmergencyFund(overrides).result;

describe('monthsText', () => {
  it('counts months, and whole years when the count is a multiple of twelve', () => {
    expect(monthsText(1)).toBe('1 month');
    expect(monthsText(12)).toBe('12 months');
    expect(monthsText(12, { years: true })).toBe('1 year');
    expect(monthsText(120, { years: true })).toBe('10 years');
    expect(monthsText(15, { years: true })).toBe('15 months');
  });
});

describe('fundHeadline', () => {
  it('names the target and how many monthly contributions reach it', () => {
    expect(fundHeadline(result())).toBe('Target $5,470, reached in 12 months');
  });

  it('says when the contribution does not reach it within the horizon', () => {
    expect(fundHeadline(result({ monthly_contribution_cents: 1_000 }))).toBe(
      'Target $5,470, not within 10 years at this amount',
    );
    expect(fundHeadline(result({ monthly_contribution_cents: 0 }))).toBe(
      'Target $5,470, not within 10 years at this amount',
    );
  });

  it('says when the savings already cover the target', () => {
    expect(fundHeadline(result({ current_balance_cents: 600_000 }))).toBe(
      'Your savings already cover the $5,470 target',
    );
  });
});

describe('fundBarTone', () => {
  it('is the emergency fund hue until funded, then confirmed', () => {
    expect(fundBarTone(result())).toBe('teal');
    expect(fundBarTone(result({ current_balance_cents: 600_000 }))).toBe('confirmed');
  });
});

describe('goalStatusBadge', () => {
  it('words and tones each status', () => {
    expect(goalStatusBadge('active')).toEqual({ label: 'Active', tone: 'teal' });
    expect(goalStatusBadge('paused')).toEqual({ label: 'Paused', tone: 'neutral' });
    expect(goalStatusBadge('reached')).toEqual({ label: 'Reached', tone: 'confirmed' });
    expect(sampleGoal().status).toBe('active');
  });
});

describe('essentialsPrefill', () => {
  it("is the summary's essentials when it has some", () => {
    expect(essentialsPrefill(sampleCashflow().spending)).toBe(182_325);
  });

  it('is null without a summary or with no essential spending in it', () => {
    expect(essentialsPrefill(undefined)).toBeNull();
    expect(essentialsPrefill({ ...sampleCashflow().spending, essentials_cents: 0 })).toBeNull();
    expect(essentialsPrefill({ ...sampleCashflow().spending, essentials_cents: -500 })).toBeNull();
  });
});

describe('accountName', () => {
  it('names an account with its last digits when it has them', () => {
    expect(accountName(sampleAccounts[1]!)).toBe('Chase Savings ··7730');
    expect(accountName({ name: 'Cash', mask: null })).toBe('Cash');
  });
});

describe('emergencyAccount', () => {
  it('is the active account marked as the emergency fund', () => {
    expect(emergencyAccount(sampleAccounts)?.name).toBe('Chase Savings');
  });

  it('is null when no active account has that role', () => {
    const [checking, savings] = sampleAccounts;
    expect(emergencyAccount([checking!])).toBeNull();
    expect(emergencyAccount([{ ...savings!, is_active: false }])).toBeNull();
    expect(emergencyAccount(undefined)).toBeNull();
  });
});

describe('goalContributionOf', () => {
  const decision = sampleEmergencyDecision();
  const saved = asEmergencyFundInputs(decision.inputs);

  it("is the goal's contribution once it was changed after the save (spec 011 rule 17b)", () => {
    const goal = sampleGoal({ monthly_contribution_cents: 50_000 });
    expect(goalContributionOf(goal, decision, saved)).toBe(50_000);
  });

  it('is null while the goal holds the saved amount, or belongs to another version', () => {
    expect(goalContributionOf(sampleGoal(), decision, saved)).toBeNull();
    const other = sampleGoal({ monthly_contribution_cents: 50_000, decision_id: 'another' });
    expect(goalContributionOf(other, decision, saved)).toBeNull();
    expect(goalContributionOf(undefined, decision, saved)).toBeNull();
    expect(goalContributionOf(sampleGoal(), undefined, null)).toBeNull();
  });
});

describe('goalPace', () => {
  const horizon = { funded: false, horizonMonths: 120 };

  it('says when an active goal is reached at its contribution', () => {
    expect(goalPace(sampleGoal(), horizon)).toBe('On pace to reach it by Sep 30, 2027.');
  });

  it('gives a paused goal no pace, dated or not (issue 166)', () => {
    expect(goalPace(sampleGoal({ status: 'paused' }), horizon)).toBe(
      'No projected date while it is paused.',
    );
    expect(goalPace(sampleGoal({ status: 'paused', target_date: null }), horizon)).toBe(
      'No projected date while it is paused.',
    );
  });

  it('says when a reached goal was reached', () => {
    const goal = sampleGoal({ status: 'reached', reached_at: '2026-10-17T15:00:00Z' });
    expect(goalPace(goal, horizon)).toBe('Reached on Oct 17, 2026.');
  });

  it('says the savings cover a funded goal, and one out of reach is not within the horizon', () => {
    const undated = sampleGoal({ target_date: null });
    expect(goalPace(undated, { funded: true, horizonMonths: 120 })).toBe(
      'Your savings already cover it.',
    );
    expect(goalPace(undated, horizon)).toBe('Not within 10 years at this amount.');
    expect(goalPace(undated, { funded: false, horizonMonths: null })).toBe(
      'Not reached at this amount.',
    );
  });
});
