import { act, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchDownloads } from '@/test/fake-download';
import {
  CALENDAR_FILENAME,
  emptyPlan,
  exportJob,
  exportJobId,
  exportJobStates,
  PLAN_PDF_FILENAME,
} from '@/test/fixtures/plan';
import { SAMPLE_NOW } from '@/test/fixtures/sample';
import { apiUrl, scriptJob } from '@/test/msw/handlers';
import { planDb } from '@/test/msw/plan-handlers';
import { server } from '@/test/msw/server';
import { renderHookWithClient } from '@/test/render';
import { API_BASE_URL } from '../base-url';
import { queryKeys } from '../keys';
import { JOB_POLL_MS } from './jobs';
import { useDownloadCalendar, useDownloadPlanPdf, useExportPlan, usePlan } from './plan';

/** `METHOD /path` of every request, in order. */
function requests() {
  const seen: string[] = [];
  server.events.on('request:start', ({ request }) => {
    seen.push(`${request.method} ${new URL(request.url).pathname}`);
  });
  return seen;
}

afterEach(() => server.events.removeAllListeners());

describe('usePlan', () => {
  it('returns the plan as the API built it, under the key a saved decision invalidates', async () => {
    const { result, queryClient } = renderHookWithClient(() => usePlan());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const plan = result.current.data!;
    expect(plan.completeness).toEqual({
      saved: ['emergency_fund', 'k401_match', 'health_plans', 'w4'],
      missing: [],
    });
    const k401 = plan.decisions.find((d) => d.calculator === 'k401_match')!;
    expect(k401.figures.map((f) => [f.label, f.value])).toEqual([
      ['Your contribution', '4.00'],
      ['Contribution for the full match', '4.00'],
      ['Employer match a year', 260_000],
      ['Match missed a year', 0],
    ]);
    expect(k401.explanation.status).toBe('verified');
    expect(plan.pay_stub?.net_cents).toBe(199_604);
    expect(queryClient.getQueryCache().findAll({ queryKey: queryKeys.plan() })).toHaveLength(1);
  });

  it('is empty for a user who has saved nothing', async () => {
    planDb.plan = emptyPlan();
    const { result } = renderHookWithClient(() => usePlan());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.decisions).toEqual([]);
    expect(result.current.data?.pay_stub).toBeNull();
  });
});

describe('useExportPlan', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(SAMPLE_NOW) }));
  afterEach(() => vi.useRealTimers());

  it('does nothing until started', async () => {
    const seen = requests();
    const { result } = renderHookWithClient(() => useExportPlan());
    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS * 2));
    expect(result.current.jobId).toBeNull();
    expect(result.current.pdfUrl).toBeNull();
    expect(seen).toEqual([]);
  });

  it('queues the export, follows its job until it succeeds, then gives the PDF URL', async () => {
    const id = exportJobId(1);
    scriptJob(exportJobStates(id));
    const seen = requests();
    const { result } = renderHookWithClient(() => useExportPlan());

    act(() => result.current.start());
    await waitFor(() => expect(result.current.jobId).toBe(id));
    await waitFor(() => expect(result.current.job.data?.status).toBe('queued'));
    expect(result.current.pdfUrl).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
    await waitFor(() => expect(result.current.job.data?.status).toBe('running'));
    expect(result.current.pdfUrl).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
    await waitFor(() => expect(result.current.job.data?.status).toBe('succeeded'));
    expect(result.current.pdfUrl).toBe(`${API_BASE_URL}/plan/export/${id}`);
    expect(seen.slice(0, 2)).toEqual(['POST /plan/export', `GET /jobs/${id}`]);
  });

  it('reports a dead export as failed, and a new start queues a new job', async () => {
    scriptJob([exportJob(exportJobId(1), { status: 'dead', last_error: 'WeasyPrint failed' })]);
    const { result } = renderHookWithClient(() => useExportPlan());

    act(() => result.current.start());
    await waitFor(() => expect(result.current.job.isFailed).toBe(true));
    expect(result.current.pdfUrl).toBeNull();

    act(() => result.current.start());
    await waitFor(() => expect(result.current.jobId).toBe(exportJobId(2)));
    await waitFor(() => expect(result.current.pdfUrl).not.toBeNull());
    expect(result.current.job.isFailed).toBe(false);
  });

  it('reports a refused start', async () => {
    server.use(
      http.post(apiUrl('/plan/export'), () =>
        HttpResponse.json(
          { error: { code: 'internal_error', message: 'Something went wrong.' } },
          { status: 500 },
        ),
      ),
    );
    const { result } = renderHookWithClient(() => useExportPlan());
    act(() => result.current.start());
    await waitFor(() =>
      expect(result.current.startError).toMatchObject({ error: { code: 'internal_error' } }),
    );
    expect(result.current.jobId).toBeNull();
  });
});

describe('the downloads', () => {
  let downloads: ReturnType<typeof watchDownloads>;
  beforeEach(() => (downloads = watchDownloads()));
  afterEach(() => {
    downloads.restore();
    vi.restoreAllMocks();
  });

  it('useDownloadCalendar saves the .ics and resolves with its name', async () => {
    const { result } = renderHookWithClient(() => useDownloadCalendar());
    await act(() => result.current.mutateAsync());
    await waitFor(() => expect(result.current.data).toBe(CALENDAR_FILENAME));
    expect(downloads.clicks.map((c) => c.download)).toEqual([CALENDAR_FILENAME]);
  });

  it('useDownloadPlanPdf saves a finished export', async () => {
    const id = exportJobId(1);
    scriptJob(exportJobStates(id).slice(2));
    planDb.exports = [id];
    const { result } = renderHookWithClient(() => useDownloadPlanPdf());
    await act(() => result.current.mutateAsync(id));
    await waitFor(() => expect(result.current.data).toBe(PLAN_PDF_FILENAME));
    expect(downloads.blobs[0]?.type).toBe('application/pdf');
  });
});
