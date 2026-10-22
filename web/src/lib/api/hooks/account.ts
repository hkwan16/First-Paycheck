import { useMutation } from '@tanstack/react-query';
import { fetchClient, sessionTokens } from '../client';
import { unwrap } from './request';

/**
 * `DELETE /me` (spec 017): delete the signed-in account and every row it
 * owns. On success the local session is cleared through the Supabase client
 * and the browser goes to `/sign-in?deleted=1` (the path a 401
 * `account_deleted` takes too). Success means the page is unloading, so a
 * caller treats it as still busy.
 */
export function useDeleteAccount() {
  return useMutation({
    mutationFn: async () => {
      await unwrap(fetchClient.DELETE('/me'));
      await sessionTokens.accountDeleted();
    },
  });
}
