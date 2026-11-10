import { useMutation, useQueryClient } from '@tanstack/react-query';
import { $api, fetchClient } from '../client';
import { invalidateAfterProfile, queryKeys } from '../keys';
import type { ProfileIn } from '../types';
import { unwrap } from './request';

/** `GET /pay-stubs`: confirmed pay stubs, newest pay date first. */
export function usePayStubs() {
  return $api.useQuery('get', '/pay-stubs');
}

/** `GET /profile`: the saved profile, or the defaults when nothing is saved. */
export function useProfile() {
  return $api.useQuery('get', '/profile');
}

/**
 * `PUT /profile`: replaces the whole profile (a field left out resets to its
 * default), so send every field. The saved profile replaces the cached one,
 * and the decisions and the plan are read again: whether a saved decision
 * needs review depends on the profile (spec 007 rule 19b).
 */
export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (profile: ProfileIn) => unwrap(fetchClient.PUT('/profile', { body: profile })),
    onSuccess: async (saved) => {
      queryClient.setQueryData(queryKeys.profile(), saved);
      await invalidateAfterProfile(queryClient);
    },
  });
}
