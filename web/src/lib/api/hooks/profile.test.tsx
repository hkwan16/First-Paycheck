import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { emptyProfile, samplePayStub } from '@/test/fixtures/documents';
import { db } from '@/test/msw/db';
import { renderHookWithClient } from '@/test/render';
import { queryKeys } from '../keys';
import { usePayStubs, useProfile, useUpdateProfile } from './profile';

describe('usePayStubs', () => {
  it('reads the confirmed pay stubs', async () => {
    db.payStubs = [samplePayStub()];
    const { result } = renderHookWithClient(() => usePayStubs());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]?.net_cents).toBe(199_604);
  });
});

describe('useProfile', () => {
  it('reads the defaults for a user who has saved nothing', async () => {
    const { result } = renderHookWithClient(() => useProfile());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(emptyProfile);
  });
});

describe('useUpdateProfile', () => {
  it('replaces the profile and puts what the server saved in the cache', async () => {
    const { result, queryClient } = renderHookWithClient(() => ({
      profile: useProfile(),
      update: useUpdateProfile(),
    }));
    await waitFor(() => expect(result.current.profile.isSuccess).toBe(true));
    act(() =>
      result.current.update.mutate({
        dependents: 0,
        pay_frequency: 'semimonthly',
        match_tiers: [{ employee_pct_upto: '4', employer_pct: '100' }],
      }),
    );
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    expect(result.current.profile.data).toMatchObject({
      pay_frequency: 'semimonthly',
      match_tiers: [{ employee_pct_upto: '4', employer_pct: '100' }],
      updated_at: expect.any(String),
    });
    expect(queryClient.getQueryData(queryKeys.profile())).toEqual(db.profile);
  });
});
