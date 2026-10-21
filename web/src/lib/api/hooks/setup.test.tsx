import { waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { emptyDb } from '@/test/msw/db';
import { renderHookWithClient } from '@/test/render';
import { useSetupFacts, useSetupProgress } from './setup';

describe('useSetupFacts', () => {
  it('reads accounts and transactions from the API and counts pending routes as nothing yet', async () => {
    const { result } = renderHookWithClient(() => useSetupFacts());
    await waitFor(() => expect(result.current.accounts).toBe(2));
    expect(result.current).toMatchObject({
      accounts: 2,
      transactions: 16,
      documents: 0,
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
    const { result } = renderHookWithClient(() => ({
      facts: useSetupFacts(),
      progress: useSetupProgress(),
    }));
    await waitFor(() => expect(result.current.facts.accounts).toBe(2));
    expect(result.current.progress.link).toBe(false);
  });
});
