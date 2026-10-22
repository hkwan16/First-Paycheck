import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { API_BASE_URL } from '../base-url';
import { $api, fetchClient } from '../client';
import { downloadCalendar, downloadPlanPdf } from '../download';
import { useJob, type JobState } from './jobs';
import { unwrap } from './request';

/**
 * `GET /plan` (spec 016): the current version of every saved decision with
 * the figures its calculator produced and its explanation status, the goals,
 * the next 90 days of the calendar and the newest confirmed pay stub, as of
 * the API's today. A saved decision, a goal change, an explanation or a
 * confirmed pay stub invalidates it (keys.ts).
 */
export function usePlan() {
  return $api.useQuery('get', '/plan');
}

export interface ExportPlanState {
  /** `POST /plan/export`; while one is still queued the API returns that job again. */
  start: () => void;
  isStarting: boolean;
  /** The start was refused (the API's error body). */
  startError: unknown;
  /** The export job being followed, once started. */
  jobId: string | null;
  job: JobState;
  /**
   * Where the finished PDF streams from (`GET /plan/export/{job_id}`), once
   * the job has succeeded; null before. It needs the bearer token, so save it
   * with `downloadPlanPdf(jobId)` (or `useDownloadPlanPdf`), not a link.
   */
  pdfUrl: string | null;
}

/**
 * The PDF export: queue it, then follow its `plan.export` job with `useJob`
 * until it succeeds or dies. A dead job is `job.isFailed`; `start()` again
 * queues a new one.
 */
export function useExportPlan(): ExportPlanState {
  const [jobId, setJobId] = useState<string | null>(null);
  const queue = useMutation({
    mutationFn: () => unwrap(fetchClient.POST('/plan/export')),
    onSuccess: ({ job_id }) => setJobId(job_id),
  });
  const job = useJob(jobId);
  const pdfUrl =
    jobId !== null && job.data?.id === jobId && job.data.status === 'succeeded'
      ? `${API_BASE_URL}/plan/export/${encodeURIComponent(jobId)}`
      : null;

  return {
    start: () => queue.mutate(),
    isStarting: queue.isPending,
    startError: queue.error,
    jobId,
    job,
    pdfUrl,
  };
}

/** Save the calendar file; resolves with the name it was saved under. */
export function useDownloadCalendar() {
  return useMutation({ mutationFn: () => downloadCalendar() });
}

/** Save a finished export's PDF by its job id; resolves with the file name. */
export function useDownloadPlanPdf() {
  return useMutation({ mutationFn: (jobId: string) => downloadPlanPdf(jobId) });
}
