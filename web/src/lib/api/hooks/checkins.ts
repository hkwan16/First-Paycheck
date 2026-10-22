import { useMutation, useQueryClient } from '@tanstack/react-query';
import { findingsReducer, userActionOf } from '@/lib/findings';
import { $api, fetchClient } from '../client';
import { invalidateCheckIn, queryKeys } from '../keys';
import type { CheckInDetail, FindingAction } from '../types';
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
