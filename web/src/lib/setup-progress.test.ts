import { describe, expect, it } from 'vitest';
import { setupProgress, type SetupFacts } from './setup-progress';

const empty: SetupFacts = {
  accounts: 0,
  documents: 0,
  confirmedPayStubs: 0,
  transactions: 0,
  categorizationFinished: false,
  liveCalculators: ['401k_match'],
  savedDecisionCalculators: [],
};

describe('setupProgress', () => {
  it('marks nothing done for a new user', () => {
    expect(setupProgress(empty)).toEqual({
      link: false,
      confirm: false,
      spending: false,
      decisions: false,
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
    expect(setupProgress({ ...twoLive, savedDecisionCalculators: ['401k_match'] }).decisions).toBe(
      false,
    );
    expect(
      setupProgress({ ...twoLive, savedDecisionCalculators: ['w4', '401k_match'] }).decisions,
    ).toBe(true);
  });

  it('ignores saved decisions for calculators that are not live', () => {
    expect(setupProgress({ ...empty, savedDecisionCalculators: ['w4'] }).decisions).toBe(false);
  });

  it('never marks decisions done when no calculator is live', () => {
    expect(setupProgress({ ...empty, liveCalculators: [] }).decisions).toBe(false);
  });
});
