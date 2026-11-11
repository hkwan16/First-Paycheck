import { QueryClient } from '@tanstack/react-query';
import { SessionUnavailable } from '@/lib/api/auth-middleware';

/**
 * A failed read retries once, except one whose session could not be read: it
 * already waited the whole session-read timeout (issue 225), and a retry
 * would only make the person wait that long again before they see why.
 */
const retryOnce = (failures: number, error: unknown) =>
  failures < 1 && !(error instanceof SessionUnavailable);

/**
 * The app's QueryClient. Data is fresh for 30 s, a failed read retries once
 * (`retryOnce`), and window focus does not refetch (numbers should not shift
 * under a person mid-decision). Mutations never retry: a save is not
 * idempotent.
 */
export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: retryOnce, refetchOnWindowFocus: false },
      mutations: { retry: 0 },
    },
  });
}
