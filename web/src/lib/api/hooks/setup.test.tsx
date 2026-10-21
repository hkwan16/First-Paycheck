import { waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { samplePayStub } from '@/test/fixtures/documents';
import { db, emptyDb, emptyDocuments, savedDecision } from '@/test/msw/db';
import { renderHookWithClient } from '@/test/render';
import { useSetupFacts, useSetupProgress } from './setup';

describe('useSetupFacts', () => {
  it('reads accounts, transactions, documents and pay stubs, and counts pending routes as nothing yet', async () => {
    const { result } = renderHookWithClient(() => useSetupFacts());
    await waitFor(() => expect(result.current.accounts).toBe(2));
    await waitFor(() => expect(result.current.documents).toBe(1));
    expect(result.current).toMatchObject({
      accounts: 2,
      transactions: 16,
      documents: 1,
      confirmedPayStubs: 0,
      categorizationFinished: false,
      savedDecisionCalculators: [],
    });
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

describe('useSetupFacts with decisions', () => {
  it('names the calculators with a saved decision by their feature flag ids', async () => {
    savedDecision();
    const { result } = renderHookWithClient(() => useSetupFacts());
    await waitFor(() => expect(result.current.savedDecisionCalculators).toEqual(['401k_match']));
  });
});
