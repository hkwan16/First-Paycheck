const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** The API's error body: `{ error: { code, message, details? } }`. */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> | null };
}

/** A parsed response body in the API's error shape (a request outside `$api` reads one). */
export const isApiErrorBody = (value: unknown): value is ApiErrorBody =>
  isRecord(value) && isRecord(value.error) && typeof value.error.message === 'string';

/**
 * A request the API refused, for every transport: `unwrap` (fetch), uploads
 * (`UploadError`) and downloads (`DownloadError`). `status` is 0 when the
 * request never got an answer. `error` mirrors the API body, so
 * `apiErrorMessage` and `apiErrorCode` read it like a bare body;
 * `retryAfterSeconds` comes from Retry-After on a 429 (the API exposes it
 * through CORS).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly error: ApiErrorBody['error'] | undefined;
  readonly retryAfterSeconds: number | null;

  constructor(status: number, body: unknown, retryAfterSeconds: number | null = null) {
    const apiError = isApiErrorBody(body) ? body.error : undefined;
    super(apiError?.message ?? (status === 0 ? 'Network error' : `Request failed (${status})`));
    this.name = 'ApiError';
    this.status = status;
    this.code = apiError?.code ?? null;
    this.error = apiError;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Retry-After as seconds from `now`: delay seconds or an HTTP date; null if unreadable. */
export function parseRetryAfter(value: string | null, now: Date = new Date()): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text);
  if (!/[a-z]/i.test(text)) return null;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now.getTime()) / 1000));
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** "in about 20 minutes", from a Retry-After in seconds; "later" when unknown. */
export function formatWait(seconds: number | null): string {
  if (seconds === null) return 'later';
  if (seconds <= 0) return 'now';
  if (seconds < 60) return `in ${plural(seconds, 'second')}`;
  if (seconds < 3600) return `in about ${plural(Math.ceil(seconds / 60), 'minute')}`;
  return `in about ${plural(Math.ceil(seconds / 3600), 'hour')}`;
}

/** The one sentence every surface shows for a 429 `rate_limited`. */
export const rateLimitMessage = (retryAfterSeconds: number | null) =>
  `You have reached the limit for now. Try again ${formatWait(retryAfterSeconds)}.`;

/**
 * The API's machine-readable code for a failed request (`decision_conflict`,
 * `not_found`), or undefined for anything that is not the API's error shape.
 */
export function apiErrorCode(error: unknown): string | undefined {
  if (!isRecord(error) || !isRecord(error.error)) return undefined;
  return typeof error.error.code === 'string' ? error.error.code : undefined;
}

/** A word with an underscore inside: a field, a code or an enum value (`emergency_fund`). */
const IDENTIFIER = /\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/;

/**
 * Whether an API message reads as a sentence for people (spec 008 rule 22a):
 * the API writes its own that way, but a validation error names fields and
 * an older API may name an identifier, which is never shown.
 */
export const isPersonMessage = (message: string) => message !== '' && !IDENTIFIER.test(message);

const isRateLimited = (error: unknown) =>
  (error instanceof ApiError && error.status === 429) || apiErrorCode(error) === 'rate_limited';

/**
 * A sentence for a failed request. A 429 says when to try again (from
 * Retry-After, through `rateLimitMessage`). Otherwise the API's errors carry
 * a message written for people (`{ error: { message } }`, a 413
 * `body_too_large` included) and FastAPI's validation errors a `detail`
 * list; anything else (a network failure, a thrown TypeError), and a message
 * that names an identifier (`isPersonMessage`), gets the caller's fallback,
 * never a raw technical string.
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (isRateLimited(error)) {
    return rateLimitMessage(error instanceof ApiError ? error.retryAfterSeconds : null);
  }
  if (!isRecord(error)) return fallback;
  if (isRecord(error.error) && typeof error.error.message === 'string' && error.error.message) {
    return isPersonMessage(error.error.message) ? error.error.message : fallback;
  }
  if (Array.isArray(error.detail)) {
    const [first] = error.detail as unknown[];
    if (isRecord(first) && typeof first.msg === 'string' && isPersonMessage(first.msg)) {
      return first.msg;
    }
  }
  return fallback;
}
