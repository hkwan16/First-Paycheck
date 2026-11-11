import { waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { samplePayStub } from '@/test/fixtures/documents';
import { db, emptyDb, emptyDocuments, savedDecision } from '@/test/msw/db';
import { spendingDb } from '@/test/msw/spending-handlers';
import { emptyPlan, partialPlan } from '@/test/fixtures/plan';
import { planDb } from '@/test/msw/plan-handlers';
import { renderHookWithClient } from '@/test/render';
import { useDecisions } from './decisions';
import { useSetupFacts, useSetupProgress } from './setup';

describe('useSetupFacts', () => {
  it('reads accounts, transactions, documents, pay stubs and the summary, and counts pending routes as nothing yet', async () => {
    const { result } = renderHookWithClient(() => useSetupFacts());
    await waitFor(() => expect(result.current.accounts).toBe(2));
    await waitFor(() => expect(result.current.documents).toBe(1));
    await waitFor(() => expect(result.current.categorizationFinished).toBe(true));
    expect(result.current).toMatchObject({
      accounts: 2,
      transactions: 16,
      documents: 1,
      confirmedPayStubs: 0,
      categorizationFinished: true,
      settledDecisionCalculators: [],
    });
  });

  it('counts categorization as unfinished while the summary has uncategorized transactions', async () => {
    spendingDb.cashflow.spending.uncategorized_count = 3;
    const { result } = renderHookWithClient(() => useSetupFacts());
    await waitFor(() => expect(result.current.transactions).toBe(16));
    expect(result.current.categorizationFinished).toBe(false);
  });
});

describe('useSetupProgress', () => {
  it('marks nothing done for a new user', async () => {
    emptyDb();
    planDb.plan = emptyPlan();
    const { result } = renderHookWithClient(() => useSetupProgress());
    await waitFor(() =>
      expect(result.current).toEqual({
        link: false,
        confirm: false,
        spending: false,
        decisions: false,
        plan: false,
        emergency_fund: false,
        '401k_match': false,
        health_plan: false,
        w4: false,
      }),
    );
  });

  it('keeps Link open until a document exists, even with accounts', async () => {
    emptyDocuments();
    const { result } = renderHookWithClient(() => ({
      facts: useSetupFacts(),
      progress: useSetupProgress(),
    }));
    await waitFor(() => expect(result.current.facts.accounts).toBe(2));
    expect(result.current.progress.link).toBe(false);
  });
});

describe('useSetupProgress with documents', () => {
  it('marks Link done once a document is uploaded, and Confirm once a pay stub is confirmed', async () => {
    const { result } = renderHookWithClient(() => useSetupProgress());
    await waitFor(() => expect(result.current.link).toBe(true));
    expect(result.current.confirm).toBe(false);
  });

  it('marks Confirm done from GET /pay-stubs', async () => {
    db.payStubs = [samplePayStub()];
    const { result } = renderHookWithClient(() => useSetupProgress());
    await waitFor(() => expect(result.current.confirm).toBe(true));
  });
});

describe('useSetupFacts with decisions', () => {
  it('names the calculators with a saved decision by their feature flag ids', async () => {
    savedDecision();
    const { result } = renderHookWithClient(() => useSetupFacts());
    await waitFor(() => expect(result.current.settledDecisionCalculators).toEqual(['401k_match']));
  });

  it('leaves out a saved decision that needs review (spec 018 rule 8, issue 222)', async () => {
    savedDecision();
    db.decisions[0]!.review = [
      {
        kind: 'changed',
        input: 'pay_periods_per_year',
        text: 'Your pay schedule changed from 26 to 24 paychecks a year.',
      },
    ];
    const { result } = renderHookWithClient(() => ({
      facts: useSetupFacts(),
      decisions: useDecisions(),
    }));
    await waitFor(() => expect(result.current.decisions.isSuccess).toBe(true));
    expect(result.current.facts.settledDecisionCalculators).toEqual([]);
  });
});

describe('useSetupProgress with the plan', () => {
  it('counts the decisions the plan says are missing, and marks the plan done at none', async () => {
    planDb.plan = partialPlan();
    const { result } = renderHookWithClient(() => useSetupFacts());
    await waitFor(() => expect(result.current.planMissingCount).toBe(3));

    planDb.plan.completeness = {
      saved: ['emergency_fund', 'k401_match', 'health_plans', 'w4'],
      missing: [],
      needs_review: [],
    };
    const progress = renderHookWithClient(() => useSetupProgress());
    await waitFor(() => expect(progress.result.current.plan).toBe(true));
  });

  it('counts the decisions the plan says need review (spec 016 rule 3a)', async () => {
    planDb.plan.completeness = {
      saved: ['emergency_fund', 'k401_match', 'health_plans', 'w4'],
      missing: [],
      needs_review: ['health_plans', 'w4'],
    };
    const { result } = renderHookWithClient(() => ({
      facts: useSetupFacts(),
      progress: useSetupProgress(),
    }));
    await waitFor(() => expect(result.current.facts.planNeedsReviewCount).toBe(2));
    expect(result.current.progress.plan).toBe(false);
  });
});
