const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * The API's machine-readable code for a failed request (`decision_conflict`,
 * `not_found`), or undefined for anything that is not the API's error shape.
 */
export function apiErrorCode(error: unknown): string | undefined {
  if (!isRecord(error) || !isRecord(error.error)) return undefined;
  return typeof error.error.code === 'string' ? error.error.code : undefined;
}

/**
 * A sentence for a failed request. The API's errors carry a message written
 * for people (`{ error: { message } }`) and FastAPI's validation errors a
 * `detail` list; anything else (a network failure, a thrown TypeError) gets
 * the caller's fallback, never a raw technical string.
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (!isRecord(error)) return fallback;
  if (isRecord(error.error) && typeof error.error.message === 'string' && error.error.message) {
    return error.error.message;
  }
  if (Array.isArray(error.detail)) {
    const [first] = error.detail as unknown[];
    if (isRecord(first) && typeof first.msg === 'string' && first.msg) return first.msg;
  }
  return fallback;
}
