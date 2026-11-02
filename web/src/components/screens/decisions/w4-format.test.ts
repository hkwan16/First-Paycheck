import { describe, expect, it } from 'vitest';
import { sampleDecision } from '@/test/fixtures/decisions';
import { sampleHealthDecision } from '@/test/fixtures/planning';
import { sampleW4, stub01W4Inputs } from '@/test/fixtures/w4';
import {
  appliedEntries,
  fromDecisions,
  hasMoreEntries,
  methodText,
  refundHeadline,
  refundTone,
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
    expect(refundTone(overWithheld.result.projected_refund_cents)).toBe('neutral');
  });

  it('reads a negative amount as a balance due, in the off tone', () => {
    expect(refundHeadline(secondJob.result.projected_refund_cents)).toBe(
      '$3,449.92 due at tax time',
    );
    expect(refundTone(secondJob.result.projected_refund_cents)).toBe('off');
  });

  it('reads zero as even', () => {
    expect(refundHeadline(0)).toBe('Even at tax time');
    expect(refundTone(0)).toBe('neutral');
  });
});

describe('suggestionText', () => {
  it('has nothing to suggest when the calculator suggests nothing', () => {
    expect(suggestionText(even.result)).toBeNull();
  });

  it('raises Step 4(c) with the amount the calculator suggests', () => {
    expect(suggestionText(secondJob.result)).toBe(
      'Enter $144.00 in Step 4(c) to have that much more taken out of each paycheck. You would then get a $6.08 refund at tax time.',
    );
  });

  it('lowers Step 4(c) to the amount the calculator suggests', () => {
    expect(suggestionText(overWithheld.result)).toBe(
      'Lower Step 4(c) to $0.00 a paycheck. You would then get a $0.08 refund at tax time.',
    );
  });

  it('adds to Step 4(b) and says the entry is more than the expected deductions', () => {
    expect(suggestionText(step2Alone.result)).toBe(
      'Enter $17,522.00 in Step 4(b). You would then get a $0.08 refund at tax time. This is more than the deductions you expect to claim, so those go in "Deductions you expect to claim" and the estimate still uses them.',
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

describe('methodText (spec 014 rule 21)', () => {
  it('says the withholding tables and the rate in words, with no publication name', () => {
    expect(methodText(even.result)).toBe(
      'The IRS withholding tables take 12% of each extra dollar of pay.',
    );
    expect(methodText(step2Alone.result)).toBe(
      'The IRS withholding tables for two jobs take 24% of each extra dollar of pay.',
    );
  });
});

describe('hasMoreEntries (spec 014 rule 20)', () => {
  const zero = { cents: 0, error: null };
  const empty = { cents: null, error: null };
  const none = { multipleJobs: false, amounts: [zero, zero], expected: empty };

  it('is false with the box clear, every amount 0 and no expected deductions', () => {
    expect(hasMoreEntries(none)).toBe(false);
  });

  it('is true for the box, an amount that is not 0, or expected deductions set', () => {
    expect(hasMoreEntries({ ...none, multipleJobs: true })).toBe(true);
    expect(hasMoreEntries({ ...none, amounts: [zero, { cents: 10_000, error: null }] })).toBe(true);
    expect(hasMoreEntries({ ...none, expected: zero })).toBe(true);
  });

  it('is true for an amount that is empty or does not read, so the person sees what to fix', () => {
    expect(hasMoreEntries({ ...none, amounts: [zero, empty] })).toBe(true);
    const unread = { cents: null, error: 'Enter an amount, like 50.00.' };
    expect(hasMoreEntries({ ...none, amounts: [unread, zero] })).toBe(true);
    expect(hasMoreEntries({ ...none, expected: unread })).toBe(true);
  });
});
