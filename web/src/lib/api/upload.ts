import { API_BASE_URL } from './base-url';
import { sessionTokens } from './client';
import type { DocumentCreated, DocumentType } from './types';

/*
 * `POST /docs` over XMLHttpRequest, because fetch cannot report upload
 * progress. Authentication matches client.ts: the same session tokens, one
 * shared refresh and one resend on a 401, then sign in again.
 */

export interface UploadDocumentOptions {
  file: File;
  type: DocumentType;
  /** Whole percent of the file sent, 0-100. */
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> | null };
}

const isApiErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error === 'object' &&
  (value as ApiErrorBody).error !== null &&
  typeof (value as ApiErrorBody).error.message === 'string';

/**
 * A failed upload. `status` is 0 when the request never got an answer.
 * `error` mirrors the API body, so `apiErrorMessage(error, fallback)` reads
 * it like any other request's error.
 */
export class UploadError extends Error {
  readonly status: number;
  readonly code: string | null;
  /** From Retry-After on a 429, when the browser can read it. */
  readonly retryAfterSeconds: number | null;
  readonly error: ApiErrorBody['error'] | undefined;

  constructor(status: number, body: unknown, retryAfterSeconds: number | null) {
    const apiError = isApiErrorBody(body) ? body.error : undefined;
    super(apiError?.message ?? (status === 0 ? 'Network error' : `Upload failed (${status})`));
    this.name = 'UploadError';
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

interface Answer {
  status: number;
  body: unknown;
  retryAfter: string | null;
}

function abortError() {
  return new DOMException('The upload was cancelled', 'AbortError');
}

function send(
  form: FormData,
  token: string | null,
  onProgress: ((percent: number) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE_URL}/docs`);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress?.(Math.round((event.loaded / event.total) * 100));
      }
    };
    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const settle = () => signal?.removeEventListener('abort', onAbort);
    xhr.onload = () => {
      settle();
      let body: unknown = null;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        body = null;
      }
      resolve({ status: xhr.status, body, retryAfter: xhr.getResponseHeader('Retry-After') });
    };
    xhr.onerror = () => {
      settle();
      resolve({ status: 0, body: null, retryAfter: null });
    };
    xhr.onabort = () => {
      settle();
      reject(abortError());
    };
    xhr.send(form);
  });
}

/** Upload one document; resolves with the new document's id. */
export async function uploadDocument({
  file,
  type,
  onProgress,
  signal,
}: UploadDocumentOptions): Promise<DocumentCreated> {
  const form = () => {
    const data = new FormData();
    data.append('type', type);
    data.append('file', file, file.name);
    return data;
  };

  let answer = await send(form(), await sessionTokens.current(), onProgress, signal);
  if (answer.status === 401 && sessionTokens.enabled()) {
    const token = await sessionTokens.refreshed();
    if (token) answer = await send(form(), token, onProgress, signal);
    if (answer.status === 401) await sessionTokens.expire();
  }

  if (answer.status >= 200 && answer.status < 300) return answer.body as DocumentCreated;
  throw new UploadError(answer.status, answer.body, parseRetryAfter(answer.retryAfter));
}
