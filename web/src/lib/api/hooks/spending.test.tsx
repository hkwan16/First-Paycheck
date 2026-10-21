import { act, waitFor } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { sampleCashflow, sampleSpendingSummary } from '@/test/fixtures/cashflow';
import { apiUrl } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderHookWithClient } from '@/test/render';
import { invalidateSpending } from '../keys';
import { useCashflow, useSpendingSummary, type Period } from './spending';

/** The query string of every request to `path`. */
function queries(path: string) {
  const seen: string[] = [];
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    if (url.pathname === path) seen.push(url.search);
  });
  return seen;
}

afterEach(() => server.events.removeAllListeners());

describe('useCashflow', () => {
  it("asks for the API's default period when none is chosen", async () => {
    const seen = queries('/cashflow');
    const { result } = renderHookWithClient(() => useCashflow(null));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(seen).toEqual(['']);
    expect(result.current.data).toEqual(sampleCashflow());
  });

  it('sends a chosen period as start and end', async () => {
    const seen = queries('/cashflow');
    const { result } = renderHookWithClient(() =>
      useCashflow({ start: '2026-08-01', end: '2026-08-31' }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(seen).toEqual(['?start=2026-08-01&end=2026-08-31']);
    expect(result.current.data).toMatchObject({ start: '2026-08-01', end: '2026-08-31' });
  });

  it('keeps showing the last period, marked as a placeholder, while the next one loads', async () => {
    server.use(
      http.get(apiUrl('/cashflow'), async ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get('start')) await delay(100);
        return HttpResponse.json({
          ...sampleCashflow(),
          start: url.searchParams.get('start') ?? '2026-10-01',
        });
      }),
    );
    const { result, rerender } = renderHookWithClient(
      ({ period }: { period: Period | null }) => useCashflow(period),
      { initialProps: { period: null as Period | null } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ period: { start: '2026-08-01', end: '2026-08-31' } });
    expect(result.current.data?.start).toBe('2026-10-01');
    expect(result.current.isPlaceholderData).toBe(true);
    await waitFor(() => expect(result.current.data?.start).toBe('2026-08-01'));
    expect(result.current.isPlaceholderData).toBe(false);
  });

  it("fails with the API's error body", async () => {
    server.use(
      http.get(apiUrl('/cashflow'), () =>
        HttpResponse.json(
          { error: { code: 'validation_error', message: 'The period is longer than 366 days' } },
          { status: 422 },
        ),
      ),
    );
    const { result } = renderHookWithClient(() => useCashflow(null));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual({
      error: { code: 'validation_error', message: 'The period is longer than 366 days' },
    });
  });

  it('reads again after a category fix changes the totals', async () => {
    const seen = queries('/cashflow');
    const { result, queryClient } = renderHookWithClient(() => useCashflow(null));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(() => invalidateSpending(queryClient));
    expect(seen).toHaveLength(2);
  });
});

describe('useSpendingSummary', () => {
  it('reads the summary for the default period', async () => {
    const { result } = renderHookWithClient(() => useSpendingSummary());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(sampleSpendingSummary);
  });

  it('reads a chosen period', async () => {
    const seen = queries('/spending/summary');
    const { result } = renderHookWithClient(() =>
      useSpendingSummary({ start: '2026-09-01', end: '2026-09-30' }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(seen).toEqual(['?start=2026-09-01&end=2026-09-30']);
  });
});
