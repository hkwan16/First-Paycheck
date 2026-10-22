import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { findingsReducer, userActionOf } from '@/lib/findings';
import { $api, fetchClient } from '../client';
import { invalidateCheckIn, queryKeys } from '../keys';
import type { CheckInDetail, FindingAction, Job } from '../types';
import { useJob, type JobState } from './jobs';
import { unwrap } from './request';

/** `GET /check-ins`: every check-in, newest month first, with finding and handled counts. */
export function useCheckIns() {
  return $api.useQuery('get', '/check-ins');
}

/**
 * `GET /check-ins/{id}`: the findings in the API's order and the month's cash
 * flow against the plan. Another person's check-in is a 404.
 */
export function useCheckIn(checkInId: string) {
  return $api.useQuery(
    'get',
    '/check-ins/{check_in_id}',
    { params: { path: { check_in_id: checkInId } } },
    // A 404 is an answer, not a blip.
    { retry: false },
  );
}

export interface UpdateFindingVariables {
  findingId: string;
  /** Done and Dismiss set `user_action`; Undo sends null. */
  type: 'done' | 'dismiss' | 'undo';
}

export interface UpdateFindingOptions {
  /**
   * Called for every refused change, after the finding is restored. Unlike a
   * callback passed to `mutate`, it also runs for an earlier change that
   * fails while a later one is in flight.
   */
  onError?: (error: unknown, variables: UpdateFindingVariables) => void;
}

interface Rollback {
  userAction: FindingAction | null;
  at: string | null;
  completedAt: string | null;
}

/**
 * `PATCH /check-ins/{id}/findings/{fid}`: mark a finding done or dismissed,
 * or undo that. Optimistic: `findingsReducer` shows the change and the new
 * counts at once; a refusal restores that one finding (so another finding
 * changed meanwhile keeps its change); when the last write in flight
 * settles, the check-in and the list are read again.
 */
export function useUpdateFinding(checkInId: string, { onError }: UpdateFindingOptions = {}) {
  const queryClient = useQueryClient();
  const key = queryKeys.checkIn(checkInId);
  const mutationKey = ['patch', '/check-ins/{check_in_id}/findings/{finding_id}', checkInId];
  return useMutation({
    mutationKey,
    mutationFn: ({ findingId, type }: UpdateFindingVariables) =>
      unwrap(
        fetchClient.PATCH('/check-ins/{check_in_id}/findings/{finding_id}', {
          params: { path: { check_in_id: checkInId, finding_id: findingId } },
          body: { user_action: userActionOf(type) },
        }),
      ),
    onMutate: async ({ findingId, type }): Promise<Rollback | undefined> => {
      await queryClient.cancelQueries({ queryKey: key });
      const before = queryClient.getQueryData<CheckInDetail>(key);
      const finding = before?.findings.find((f) => f.id === findingId);
      const at = new Date().toISOString();
      queryClient.setQueryData<CheckInDetail>(
        key,
        (detail) => detail && findingsReducer(detail, { type, findingId, at }),
      );
      return finding
        ? {
            userAction: finding.user_action,
            at: finding.user_action_at,
            completedAt: before?.completed_at ?? null,
          }
        : undefined;
    },
    onError: (error, variables, rollback) => {
      const { findingId } = variables;
      if (rollback) {
        queryClient.setQueryData<CheckInDetail>(
          key,
          (detail) =>
            detail &&
            findingsReducer(detail, {
              type: 'restore',
              findingId,
              userAction: rollback.userAction,
              at: rollback.at,
              completedAt: rollback.completedAt,
            }),
        );
      }
      onError?.(error, variables);
    },
    onSettled: () => {
      // Reading while another write is in flight would overwrite its optimistic change.
      if (queryClient.isMutating({ mutationKey }) > 1) return;
      return invalidateCheckIn(queryClient, checkInId);
    },
  });
}

/** What a finished `checkin.monthly` run did (spec 015 rule 8). */
export type CheckInOutcome = 'created' | 'refreshed' | 'skipped';

const OUTCOMES: ReadonlySet<string> = new Set(['created', 'refreshed', 'skipped']);

/**
 * The outcome and check-in a succeeded `checkin.monthly` job reports in its
 * `result` (`CheckInRun.as_job_result`); null before it succeeds.
 */
export function checkInRunOf(
  job: Job | undefined,
): { outcome: CheckInOutcome; checkInId: string | null } | null {
  if (job?.kind !== 'checkin.monthly' || job.status !== 'succeeded') return null;
  const outcome = job.result?.outcome;
  const checkInId = job.result?.check_in_id;
  if (typeof outcome !== 'string' || !OUTCOMES.has(outcome)) return null;
  return {
    outcome: outcome as CheckInOutcome,
    checkInId: typeof checkInId === 'string' ? checkInId : null,
  };
}

export interface CheckInNowState {
  /** `POST /check-ins`; while the month's run is still queued the API returns that job again. */
  start: () => void;
  isStarting: boolean;
  /** The start was refused (an `ApiError`: a 429 says when to try again). */
  startError: unknown;
  /** The `checkin.monthly` job being followed, once started. */
  jobId: string | null;
  job: JobState;
  /**
   * This month's check-in: the one the 202 named, then the one the finished
   * job reports (a new check-in has no id before its run makes it).
   */
  checkInId: string | null;
  /** What the run did, once its job succeeded; null before. */
  outcome: CheckInOutcome | null;
}

/**
 * "Check in now" (spec 015 rule 23): queue this month's check-in run, then
 * follow its `checkin.monthly` job with `useJob` until it succeeds or dies.
 * When it finishes, `useJob` reads the list and every check-in again
 * (`JOB_INVALIDATES`). A dead job is `job.isFailed`; `start()` again queues a
 * new run.
 */
export function useCheckInNow(): CheckInNowState {
  const [queued, setQueued] = useState<{ jobId: string; checkInId: string | null } | null>(null);
  const queue = useMutation({
    mutationFn: () => unwrap(fetchClient.POST('/check-ins')),
    onSuccess: ({ job_id, check_in_id }) => setQueued({ jobId: job_id, checkInId: check_in_id }),
  });
  const jobId = queued?.jobId ?? null;
  const job = useJob(jobId);
  const run = job.data?.id === jobId ? checkInRunOf(job.data) : null;

  return {
    start: () => queue.mutate(),
    isStarting: queue.isPending,
    startError: queue.error,
    jobId,
    job,
    checkInId: run?.checkInId ?? queued?.checkInId ?? null,
    outcome: run?.outcome ?? null,
  };
}
