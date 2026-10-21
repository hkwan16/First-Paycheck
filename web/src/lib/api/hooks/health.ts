import { $api } from '../client';

/**
 * Typed TanStack Query hooks over the generated API. Screens call these (or
 * `$api.useQuery` directly for one-off reads); every request goes through the
 * bearer-token middleware in `client.ts`.
 */

/** `GET /health`: the API's status, deployed git SHA and Alembic revision. */
export function useHealth() {
  return $api.useQuery('get', '/health');
}
