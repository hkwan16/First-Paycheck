import { useMutation, useQueryClient } from '@tanstack/react-query';
import { $api, fetchClient } from '../client';
import { invalidateRecurring, queryKeys } from '../keys';
import type { RecurringCharge, RecurringPatch } from '../types';
import { unwrap } from './request';

/** `GET /recurring`: every detected charge, ignored ones included, ordered by name. */
export function useRecurring() {
  return $api.useQuery('get', '/recurring');
}

export interface UpdateRecurringVariables {
  chargeId: string;
  /** Only the fields to change; `user_status: null` clears the person's mark. */
  patch: RecurringPatch;
}

/** The charge as the server will store it after `patch` (spec 009 rule 17). */
function applyPatch(charge: RecurringCharge, patch: RecurringPatch): RecurringCharge {
  const next = { ...charge };
  if ('user_status' in patch) next.user_status = patch.user_status ?? null;
  if (typeof patch.merchant_clean === 'string') next.merchant_clean = patch.merchant_clean.trim();
  return next;
}

/**
 * `PATCH /recurring/{id}`: mark a charge not recurring (`ignored`), confirm
 * or cancel it, or rename it. Optimistic: every cached list shows the change
 * at once, a failure puts the snapshot back, and the list is read again
 * either way.
 */
export function useUpdateRecurring() {
  const queryClient = useQueryClient();
  const prefix = { queryKey: queryKeys.recurring() };
  return useMutation({
    mutationFn: ({ chargeId, patch }: UpdateRecurringVariables) =>
      unwrap(
        fetchClient.PATCH('/recurring/{charge_id}', {
          params: { path: { charge_id: chargeId } },
          body: patch,
        }),
      ),
    onMutate: async ({ chargeId, patch }) => {
      await queryClient.cancelQueries(prefix);
      const snapshot = queryClient.getQueriesData<RecurringCharge[]>(prefix);
      queryClient.setQueriesData<RecurringCharge[]>(prefix, (charges) =>
        charges?.map((c) => (c.id === chargeId ? applyPatch(c, patch) : c)),
      );
      return { snapshot };
    },
    onError: (_error, _variables, context) => {
      for (const [key, data] of context?.snapshot ?? []) queryClient.setQueryData(key, data);
    },
    onSettled: () => invalidateRecurring(queryClient),
  });
}
