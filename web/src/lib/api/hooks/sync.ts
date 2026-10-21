import { useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchClient } from '../client';
import { invalidateLinkedData } from '../keys';
import { unwrap } from './request';

/** Plaid's sandbox First Platypus Bank, linked without Plaid Link (non-production only). */
export const SANDBOX_INSTITUTION_ID = 'ins_109508';

/**
 * `POST /sync/link-token`. A mutation, not a query: a token is created when
 * the person asks to link a bank, not on every visit to the screen.
 */
export function useLinkToken() {
  return useMutation({
    mutationFn: () => unwrap(fetchClient.POST('/sync/link-token')),
  });
}

export interface CreateSyncItemVariables {
  /** From Plaid Link's onSuccess. */
  publicToken: string;
  institutionName?: string | null;
}

/** `POST /sync/items` with a Link public token: returns the item and its initial sync job. */
export function useCreateSyncItem() {
  return useMutation({
    mutationFn: ({ publicToken, institutionName }: CreateSyncItemVariables) =>
      unwrap(
        fetchClient.POST('/sync/items', {
          body: institutionName
            ? { public_token: publicToken, institution_name: institutionName }
            : { public_token: publicToken },
        }),
      ),
  });
}

/**
 * `POST /sync/items` with `sandbox_institution_id`: the API creates the public
 * token itself. The API refuses it in production; the button that calls it
 * renders only under the `e2e` feature flag.
 */
export function useSandboxLink(institutionId: string = SANDBOX_INSTITUTION_ID) {
  return useMutation({
    mutationFn: () =>
      unwrap(fetchClient.POST('/sync/items', { body: { sandbox_institution_id: institutionId } })),
  });
}

/** `POST /sync/items/{id}/sync`: queue an incremental sync; returns its job id. */
export function useTriggerSync() {
  return useMutation({
    mutationFn: (itemId: string) =>
      unwrap(
        fetchClient.POST('/sync/items/{item_id}/sync', { params: { path: { item_id: itemId } } }),
      ),
  });
}

/**
 * `DELETE /sync/items/{id}`: unlink an institution with its accounts and
 * transactions. Not optimistic: the rows leave when the server says they are gone.
 */
export function useUnlinkItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) =>
      unwrap(
        fetchClient.DELETE('/sync/items/{item_id}', { params: { path: { item_id: itemId } } }),
      ),
    onSuccess: () => invalidateLinkedData(queryClient),
  });
}
