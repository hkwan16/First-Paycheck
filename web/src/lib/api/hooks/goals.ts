import { useMutation, useQueryClient } from '@tanstack/react-query';
import { $api, fetchClient } from '../client';
import { queryKeys } from '../keys';
import type { Goal, GoalPatch } from '../types';
import { unwrap } from './request';

/**
 * `GET /goals`: the person's savings goals, oldest first, each with the
 * linked account's latest balance and the API's progress percentage. Saving
 * an emergency fund decision creates or updates the emergency fund goal.
 */
export function useGoals() {
  return $api.useQuery('get', '/goals');
}

export interface UpdateGoalVariables {
  goalId: string;
  /** Only the fields to change; one left out is unchanged. */
  patch: GoalPatch;
}

/**
 * `PATCH /goals/{id}`: pause, resume or mark a goal reached, or change its
 * monthly contribution (which clears its projected date: the projection
 * belongs to a saved decision). Not optimistic, because the server decides
 * `reached_at` and `target_date`; the goal it returns replaces the cached one,
 * then the list is read again.
 */
export function useUpdateGoal() {
  const queryClient = useQueryClient();
  const key = queryKeys.goals();
  return useMutation({
    mutationFn: ({ goalId, patch }: UpdateGoalVariables) =>
      unwrap(
        fetchClient.PATCH('/goals/{goal_id}', {
          params: { path: { goal_id: goalId } },
          body: patch,
        }),
      ),
    onSuccess: (saved) =>
      queryClient.setQueryData<Goal[]>(key, (goals) =>
        goals?.map((goal) => (goal.id === saved.id ? saved : goal)),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}
