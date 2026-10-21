import { act, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleJob } from '@/test/fixtures/sample';
import { apiUrl, scriptJob, syncJobStates } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderHookWithClient } from '@/test/render';
import { queryKeys } from '../keys';
import { JOB_POLL_MS, useJob } from './jobs';

const JOB_ID = '5a000000-0000-4000-8000-00000000aaaa';

function countJobRequests() {
  const seen = { count: 0 };
  server.events.on('request:start', ({ request }) => {
    if (new URL(request.url).pathname === `/jobs/${JOB_ID}`) seen.count += 1;
  });
  return seen;
}

describe('useJob', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => {
    vi.useRealTimers();
    server.events.removeAllListeners();
  });

  it('polls every 1.5 s until the job is terminal, then stops', async () => {
    scriptJob(syncJobStates(JOB_ID));
    const requests = countJobRequests();
    const { result } = renderHookWithClient(() => useJob(JOB_ID));

    await waitFor(() => expect(result.current.data?.status).toBe('queued'));
    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
    await waitFor(() => expect(result.current.data?.status).toBe('running'));
    expect(result.current.data?.progress).toBe(40);
    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
    await waitFor(() => expect(result.current.data?.status).toBe('succeeded'));
    expect(result.current.isTerminal).toBe(true);

    const settled = requests.count;
    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS * 4));
    expect(requests.count).toBe(settled);
  });

  it('invalidates what the job kind changes, once, when it finishes', async () => {
    scriptJob([
      sampleJob({ id: JOB_ID, status: 'running', progress: 50 }),
      sampleJob({ id: JOB_ID, status: 'succeeded', progress: 100 }),
    ]);
    const { result, queryClient } = renderHookWithClient(() => useJob(JOB_ID));
    queryClient.setQueryData(queryKeys.accounts(), []);
    queryClient.setQueryData(queryKeys.transactionPages({ limit: 50 }), { pages: [] });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    await waitFor(() => expect(result.current.data?.status).toBe('running'));
    expect(queryClient.getQueryState(queryKeys.accounts())?.isInvalidated).toBe(false);

    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
    await waitFor(() => expect(result.current.data?.status).toBe('succeeded'));
    await waitFor(() =>
      expect(queryClient.getQueryState(queryKeys.accounts())?.isInvalidated).toBe(true),
    );
    expect(
      queryClient.getQueryState(queryKeys.transactionPages({ limit: 50 }))?.isInvalidated,
    ).toBe(true);
    const calls = invalidate.mock.calls.length;

    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS * 2));
    expect(invalidate.mock.calls.length).toBe(calls);
  });

  it('reports a dead job as failed with its error', async () => {
    scriptJob([sampleJob({ id: JOB_ID, status: 'dead', last_error: 'Plaid said no' })]);
    const { result } = renderHookWithClient(() => useJob(JOB_ID));
    await waitFor(() => expect(result.current.isFailed).toBe(true));
    expect(result.current.data?.last_error).toBe('Plaid said no');
  });

  it('stops polling and reports failure when the job cannot be read', async () => {
    server.use(
      http.get(apiUrl(`/jobs/${JOB_ID}`), () =>
        HttpResponse.json(
          { error: { code: 'not_found', message: 'Job not found' } },
          { status: 404 },
        ),
      ),
    );
    const requests = countJobRequests();
    const { result } = renderHookWithClient(() => useJob(JOB_ID));
    await waitFor(() => expect(result.current.isFailed).toBe(true));
    const settled = requests.count;
    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS * 3));
    expect(requests.count).toBe(settled);
  });

  it('does nothing without a job id', async () => {
    const requests = countJobRequests();
    const { result } = renderHookWithClient(() => useJob(null));
    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS * 2));
    expect(result.current.data).toBeUndefined();
    expect(result.current.isFailed).toBe(false);
    expect(requests.count).toBe(0);
  });
});
