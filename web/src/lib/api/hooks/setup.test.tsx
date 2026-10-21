import { waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { samplePayStub } from '@/test/fixtures/documents';
import { db, emptyDb, emptyDocuments } from '@/test/msw/db';
import { spendingDb } from '@/test/msw/spending-handlers';
import { renderHookWithClient } from '@/test/render';
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
      savedDecisionCalculators: [],
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
    const { result } = renderHookWithClient(() => useSetupProgress());
    await waitFor(() =>
      expect(result.current).toEqual({
        link: false,
        confirm: false,
        spending: false,
        decisions: false,
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
