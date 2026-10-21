import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { $api } from '../client';
import { invalidateForJob } from '../keys';
import type { Job, JobStatus } from '../types';

/** How often a running job is polled. */
export const JOB_POLL_MS = 1_500;

const TERMINAL: ReadonlySet<JobStatus> = new Set(['succeeded', 'dead']);

export const isTerminalStatus = (status: JobStatus | undefined) =>
  status !== undefined && TERMINAL.has(status);

export interface JobState {
  data: Job | undefined;
  /** Polling failed (the job is gone, or the API is unreachable). */
  error: unknown;
  /** Succeeded or dead: polling has stopped. */
  isTerminal: boolean;
  /** Dead, or unreadable: show the failure and a retry. */
  isFailed: boolean;
  /** Read the job again after a failed poll. */
  refetch: () => void;
}

/**
 * `GET /jobs/{id}` every 1.5 s until the job succeeds or dies. When it
 * finishes, the reads its kind changes are invalidated once (keys.ts,
 * JOB_INVALIDATES), so a finished sync brings its accounts and transactions
 * onto the screen without the screen knowing what a sync touches.
 */
export function useJob(jobId: string | null | undefined): JobState {
  const queryClient = useQueryClient();
  const query = $api.useQuery(
    'get',
    '/jobs/{job_id}',
    { params: { path: { job_id: jobId ?? '' } } },
    {
      enabled: Boolean(jobId),
      // Progress changes server side; never serve a cached state.
      staleTime: 0,
      retry: false,
      refetchInterval: (q) =>
        q.state.status === 'error' || isTerminalStatus(q.state.data?.status) ? false : JOB_POLL_MS,
      // A sync keeps going while the tab is hidden; its result should be there on return.
      refetchIntervalInBackground: true,
    },
  );

  const job = query.data;
  const finished = useRef(new Set<string>());
  useEffect(() => {
    if (!job || !isTerminalStatus(job.status) || finished.current.has(job.id)) return;
    finished.current.add(job.id);
    void invalidateForJob(queryClient, job.kind);
  }, [job, queryClient]);

  const enabled = Boolean(jobId);
  return {
    data: enabled ? job : undefined,
    error: enabled ? query.error : null,
    isTerminal: enabled && isTerminalStatus(job?.status),
    isFailed: enabled && (job?.status === 'dead' || query.isError),
    refetch: () => void query.refetch(),
  };
}
