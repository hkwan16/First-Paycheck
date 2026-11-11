import { useMutation, useQueryClient } from '@tanstack/react-query';
import { $api, fetchClient } from '../client';
import { invalidateAccounts, queryKeys } from '../keys';
import type { Account, AccountPatch } from '../types';
import { unwrap } from './request';

/** `GET /accounts`: every linked account with its latest balance. */
export function useAccounts() {
  return $api.useQuery('get', '/accounts');
}

export interface UpdateAccountVariables {
  accountId: string;
  /** Send both fields: "Not used" is `{ role: null, is_active: false }`. */
  patch: AccountPatch;
}

/**
 * `PATCH /accounts/{id}`. The select shows the new role at once (optimistic),
 * goes back on failure, and refetches afterwards because making one account
 * the emergency fund clears that role from the others on the server.
 */
export function useUpdateAccount() {
  const queryClient = useQueryClient();
  const key = queryKeys.accounts();
  return useMutation({
    mutationFn: ({ accountId, patch }: UpdateAccountVariables) =>
      unwrap(
        fetchClient.PATCH('/accounts/{account_id}', {
          params: { path: { account_id: accountId } },
          body: patch,
        }),
      ),
    onMutate: async ({ accountId, patch }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<Account[]>(key);
      queryClient.setQueryData<Account[]>(key, (accounts) =>
        accounts?.map((a) => (a.id === accountId ? { ...a, ...patch } : a)),
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSettled: () => invalidateAccounts(queryClient),
  });
}
