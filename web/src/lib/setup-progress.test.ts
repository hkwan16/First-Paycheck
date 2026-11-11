import { describe, expect, it } from 'vitest';
import { setupProgress, type SetupFacts } from './setup-progress';

const empty: SetupFacts = {
  accounts: 0,
  documents: 0,
  confirmedPayStubs: 0,
  transactions: 0,
  categorizationFinished: false,
  liveCalculators: ['401k_match'],
  settledDecisionCalculators: [],
  planMissingCount: null,
  planNeedsReviewCount: null,
};

describe('setupProgress', () => {
  it('marks nothing done for a new user', () => {
    expect(setupProgress(empty)).toEqual({
      link: false,
      confirm: false,
      spending: false,
      decisions: false,
      plan: false,
      emergency_fund: false,
      '401k_match': false,
      health_plan: false,
      w4: false,
    });
  });

  it('marks link done only with at least one account and one document', () => {
    expect(setupProgress({ ...empty, accounts: 1 }).link).toBe(false);
    expect(setupProgress({ ...empty, documents: 1 }).link).toBe(false);
    expect(setupProgress({ ...empty, accounts: 2, documents: 1 }).link).toBe(true);
  });

  it('marks confirm done once a pay stub is confirmed', () => {
    expect(setupProgress({ ...empty, confirmedPayStubs: 1 }).confirm).toBe(true);
  });

  it('marks spending done when transactions exist and categorization finished', () => {
    expect(setupProgress({ ...empty, transactions: 94 }).spending).toBe(false);
    expect(setupProgress({ ...empty, categorizationFinished: true }).spending).toBe(false);
    expect(
      setupProgress({ ...empty, transactions: 94, categorizationFinished: true }).spending,
    ).toBe(true);
  });

  it('marks decisions done when every live calculator has a saved decision', () => {
    const twoLive: SetupFacts = { ...empty, liveCalculators: ['401k_match', 'w4'] };
    expect(
      setupProgress({ ...twoLive, settledDecisionCalculators: ['401k_match'] }).decisions,
    ).toBe(false);
    expect(
      setupProgress({ ...twoLive, settledDecisionCalculators: ['w4', '401k_match'] }).decisions,
    ).toBe(true);
  });

  it('ignores saved decisions for calculators that are not live', () => {
    expect(setupProgress({ ...empty, settledDecisionCalculators: ['w4'] }).decisions).toBe(false);
  });

  it('never marks decisions done when no calculator is live', () => {
    expect(setupProgress({ ...empty, liveCalculators: [] }).decisions).toBe(false);
  });

  it("marks each saved live calculator's step (spec 018 rule 8)", () => {
    const progress = setupProgress({
      ...empty,
      liveCalculators: ['emergency_fund', '401k_match', 'health_plan', 'w4'],
      settledDecisionCalculators: ['401k_match', 'w4'],
    });
    expect(progress).toMatchObject({
      emergency_fund: false,
      '401k_match': true,
      health_plan: false,
      w4: true,
      decisions: false,
    });
  });

  it('never marks a step that is not live, even with a saved decision', () => {
    const progress = setupProgress({ ...empty, settledDecisionCalculators: ['w4'] });
    expect(progress.w4).toBe(false);
    expect(progress.decisions).toBe(false);
  });

  it('marks Decisions done with its one live step in the alpha', () => {
    const progress = setupProgress({ ...empty, settledDecisionCalculators: ['401k_match'] });
    expect(progress['401k_match']).toBe(true);
    expect(progress.decisions).toBe(true);
  });

  it('a decision that needs review is not done (spec 018 rule 8, issue 222)', () => {
    // Saved: all four. Settled: the two whose saved decision needs no review.
    const progress = setupProgress({
      ...empty,
      liveCalculators: ['emergency_fund', '401k_match', 'health_plan', 'w4'],
      settledDecisionCalculators: ['emergency_fund', '401k_match'],
    });
    expect(progress).toMatchObject({
      emergency_fund: true,
      '401k_match': true,
      health_plan: false,
      w4: false,
      decisions: false,
    });
  });

  it('marks the plan done once the API says no decision is missing from it', () => {
    const settled = { ...empty, planNeedsReviewCount: 0 };
    expect(setupProgress({ ...settled, planMissingCount: null }).plan).toBe(false);
    expect(setupProgress({ ...settled, planMissingCount: 1 }).plan).toBe(false);
    expect(setupProgress({ ...settled, planMissingCount: 0 }).plan).toBe(true);
  });

  it('and nothing in it needs review (spec 016 rule 3a)', () => {
    const whole = { ...empty, planMissingCount: 0 };
    expect(setupProgress({ ...whole, planNeedsReviewCount: null }).plan).toBe(false);
    expect(setupProgress({ ...whole, planNeedsReviewCount: 3 }).plan).toBe(false);
    expect(setupProgress({ ...whole, planNeedsReviewCount: 0 }).plan).toBe(true);
  });
});
