import { describe, expect, it } from 'vitest';
import { sampleDecision } from '@/test/fixtures/decisions';
import { stub01PayStub } from '@/test/fixtures/documents';
import { sampleHealthDecision } from '@/test/fixtures/planning';
import { sampleW4, stub01W4Inputs } from '@/test/fixtures/w4';
import {
  appliedEntries,
  currentWithholdingOf,
  fromDecisions,
  refundHeadline,
  refundText,
  refundTone,
  scheduleText,
  suggestionText,
  W4_CONTEXT_INPUTS,
} from './w4-format';

// Cases from w4-results.json (the API's calculator), so every amount is one it returned.
const even = sampleW4();
const overWithheld = sampleW4({ extra_withholding_cents: 10_000 });
const secondJob = sampleW4({
  other_jobs_wages_cents: 2_000_000,
  other_jobs_withholding_cents: 39_000,
});
const step2Alone = sampleW4({ multiple_jobs: true });

describe('refund wording and tone', () => {
  it('reads a positive amount as a refund, in a neutral tone (a refund is not a success)', () => {
    expect(refundHeadline(overWithheld.result.projected_refund_cents)).toBe(
      'A $2,400.08 refund at tax time',
    );
    expect(refundText(overWithheld.result.projected_refund_cents)).toBe('$2,400.08 refund');
    expect(refundTone(overWithheld.result.projected_refund_cents)).toBe('neutral');
  });

  it('reads a negative amount as a balance due, in the off tone', () => {
    expect(refundHeadline(secondJob.result.projected_refund_cents)).toBe(
      '$3,449.92 due at tax time',
    );
    expect(refundText(secondJob.result.projected_refund_cents)).toBe('$3,449.92 due');
    expect(refundTone(secondJob.result.projected_refund_cents)).toBe('off');
  });

  it('reads zero as even', () => {
    expect(refundHeadline(0)).toBe('Even at tax time');
    expect(refundText(0)).toBe('Nothing due, no refund');
    expect(refundTone(0)).toBe('neutral');
  });
});

describe('suggestionText', () => {
  it('has nothing to suggest when the calculator suggests nothing', () => {
    expect(suggestionText(even.result)).toBeNull();
  });

  it('raises Step 4(c) with the amount the calculator suggests', () => {
    expect(suggestionText(secondJob.result)).toBe(
      'Enter $144.00 in Step 4(c) to withhold that much more each paycheck. That brings tax time to a $6.08 refund.',
    );
  });

  it('lowers Step 4(c) to the amount the calculator suggests', () => {
    expect(suggestionText(overWithheld.result)).toBe(
      'Lower Step 4(c) to $0.00 a paycheck. That brings tax time to a $0.08 refund.',
    );
  });

  it('adds to Step 4(b) and says the entry is more than the expected deductions', () => {
    expect(suggestionText(step2Alone.result)).toBe(
      'Enter $17,522.00 in Step 4(b). That brings tax time to a $0.08 refund. The entry is larger than the deductions you expect, which stay in "Deductions you expect to claim".',
    );
  });
});

describe('appliedEntries', () => {
  it("copies the suggested Step 4(b) and 4(c) entries from the calculator's result", () => {
    expect(appliedEntries(secondJob.inputs, secondJob.result)).toEqual({
      extra_withholding_cents: 14_400,
      deductions_cents: 0,
      expected_deductions_cents: null,
    });
  });

  it('keeps the Step 4(b) entry as the expected deductions when Step 4(b) grows', () => {
    expect(appliedEntries(step2Alone.inputs, step2Alone.result)).toEqual({
      extra_withholding_cents: 0,
      deductions_cents: 1_752_200,
      expected_deductions_cents: 0,
    });
    // Expected deductions already set stay as they are.
    expect(
      appliedEntries(
        { ...step2Alone.inputs, expected_deductions_cents: 50_000 },
        step2Alone.result,
      ),
    ).toMatchObject({ expected_deductions_cents: 50_000 });
  });
});

describe('fromDecisions', () => {
  it("reads the saved 401(k) rate and the chosen health plan's premium per paycheck", () => {
    expect(fromDecisions(sampleDecision(), sampleHealthDecision())).toEqual({
      k401Pct: '4.00',
      premium: { cents: 6_250, plan: 'Gold PPO' },
    });
  });

  it('is empty for decisions not saved, or not readable', () => {
    expect(fromDecisions(undefined, undefined)).toEqual({ k401Pct: null, premium: null });
    expect(
      fromDecisions(
        sampleDecision({ inputs: { contribution_pct: 4 } }),
        sampleHealthDecision({
          inputs: { ...sampleHealthDecision().inputs, selected_plan_index: null },
        }),
      ),
    ).toEqual({ k401Pct: null, premium: null });
  });
});

describe('the comparison at the stub withholding (spec 014 rule 10a)', () => {
  it("sends the newest stub's federal withholding when the stub is on the card's schedule", () => {
    expect(currentWithholdingOf(stub01PayStub(), 'biweekly')).toBe(27_244);
    expect(currentWithholdingOf(stub01PayStub({ federal_withholding_cents: 0 }), 'biweekly')).toBe(
      0,
    );
    // A stub with no schedule is taken to be on the card's.
    expect(currentWithholdingOf(stub01PayStub({ pay_frequency: null }), 'semimonthly')).toBe(
      27_244,
    );
  });

  it('sends nothing for a stub on another schedule: its paycheck is a different length', () => {
    expect(currentWithholdingOf(stub01PayStub(), 'semimonthly')).toBeNull();
    expect(currentWithholdingOf(stub01PayStub(), null)).toBeNull();
  });

  it("words the e2e account's balance due at its stub's withholding in the off tone", () => {
    const { result } = sampleW4(stub01W4Inputs());
    expect(refundHeadline(result.current_refund_cents!)).toBe('$3,918.70 due at tax time');
    expect(refundTone(result.current_refund_cents!)).toBe('off');
    // The sample stub keeps more than the year needs: a refund, neutral.
    expect(refundHeadline(even.result.current_refund_cents!)).toBe(
      'A $2,018.24 refund at tax time',
    );
    expect(refundTone(even.result.current_refund_cents!)).toBe('neutral');
  });

  it('leaves the stub withholding out of the saved comparison: it is payroll today, not an entry', () => {
    expect(W4_CONTEXT_INPUTS).toEqual(['current_withholding_per_paycheck_cents']);
  });
});

describe('scheduleText', () => {
  it('names the Pub 15-T schedule and the rate of the row used', () => {
    expect(scheduleText(even.result)).toBe('Standard schedule, 12% row');
    expect(scheduleText(step2Alone.result)).toBe('Step 2 checkbox schedule, 24% row');
  });
});
