import { ApiError, parseRetryAfter } from '../errors';

/**
 * Turn a refused `openapi-fetch` call into an `ApiError` (the status, the
 * API's `{ error: { code, message } }` body as `error`, and Retry-After), so
 * every mutation's `error` reads through `apiErrorMessage` and a 429 says when
 * to try again. A request that got no answer rejects as it is (a TypeError).
 */
export function apiErrorFrom(response: Response, body: unknown): ApiError {
  return new ApiError(response.status, body, parseRetryAfter(response.headers.get('Retry-After')));
}

/** The data of an `openapi-fetch` call, or an `ApiError` thrown for a refusal. */
export async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await call;
  if (error !== undefined) throw apiErrorFrom(response, error);
  return data as T;
}
