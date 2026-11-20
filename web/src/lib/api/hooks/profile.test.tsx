import { act, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyProfile, samplePayStub } from '@/test/fixtures/documents';
import { db } from '@/test/msw/db';
import { apiUrl, profileOut } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderHookWithClient } from '@/test/render';
import { queryKeys } from '../keys';
import { usePayStubs, useProfile, useSaveTimeZone, useToday, useUpdateProfile } from './profile';

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
      match_tiers: [{ employee_pct_upto: '4.00', employer_pct: '100.00' }],
      updated_at: expect.any(String),
    });
    expect(queryClient.getQueryData(queryKeys.profile())).toEqual(profileOut());
  });

  it('reads the decisions and the plan again: their review reads the profile (issue 222)', async () => {
    const { result, queryClient } = renderHookWithClient(() => useUpdateProfile());
    queryClient.setQueryData(queryKeys.decisions(), { items: [] });
    queryClient.setQueryData(queryKeys.plan(), {});
    act(() => result.current.mutate({ dependents: 0 }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryState(queryKeys.decisions())?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(queryKeys.plan())?.isInvalidated).toBe(true);
  });
});

describe('useToday', () => {
  it('is null until GET /profile answers, then the person’s today the API worked out', async () => {
    // Spec 019 rule 6: never the browser's clock (23:30 Pacific on October 17 was
    // October 18 in UTC, the date the web used to read).
    db.profile.today = '2026-10-17';
    const { result } = renderHookWithClient(() => useToday());
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe('2026-10-17'));
  });
});

describe('useSaveTimeZone', () => {
  afterEach(() => server.events.removeAllListeners());

  it('saves the browser’s zone, caches the profile and reads everything again', async () => {
    const { result, queryClient } = renderHookWithClient(() => useSaveTimeZone());
    queryClient.setQueryData(queryKeys.plan(), {});
    queryClient.setQueryData(queryKeys.checkIns(), []);
    const sent: unknown[] = [];
    server.events.on('request:start', async ({ request }) => {
      if (request.method === 'PUT') sent.push(await request.clone().json());
    });
    act(() => result.current.mutate('America/Los_Angeles'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(sent).toEqual([{ time_zone: 'America/Los_Angeles' }]);
    expect(queryClient.getQueryData(queryKeys.profile())).toMatchObject({
      time_zone: 'America/Los_Angeles',
    });
    // The person's today, and with it every date the API answers, may have moved.
    expect(queryClient.getQueryState(queryKeys.plan())?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(queryKeys.checkIns())?.isInvalidated).toBe(true);
  });

  it('fails with the API’s refusal of a zone it does not know', async () => {
    server.use(
      http.put(apiUrl('/profile/time-zone'), () =>
        HttpResponse.json(
          { error: { code: 'validation_error', message: 'Choose a time zone.' } },
          { status: 422 },
        ),
      ),
    );
    const { result } = renderHookWithClient(() => useSaveTimeZone());
    act(() => result.current.mutate('Mars/Olympus'));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ status: 422, code: 'validation_error' });
  });
});
