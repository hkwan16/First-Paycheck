import { QueryClient } from '@tanstack/react-query';

/**
 * The app's QueryClient. Data is fresh for 30 s, a failed read retries once,
 * and window focus does not refetch (numbers should not shift under a person
 * mid-decision). Mutations never retry: a save is not idempotent.
 */
export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
      mutations: { retry: 0 },
    },
  });
}
