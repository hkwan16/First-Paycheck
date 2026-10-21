/**
 * The data of an `openapi-fetch` call, or its error thrown as-is (the API's
 * `{ error: { code, message } }` body), the way `$api` hooks throw, so every
 * hook's `error` has one shape for `apiErrorMessage`.
 */
export async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error } = await call;
  if (error !== undefined) throw error;
  return data as T;
}
