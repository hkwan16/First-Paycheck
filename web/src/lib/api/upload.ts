import { API_BASE_URL } from './base-url';
import { sessionTokens } from './client';
import { ApiError, apiErrorCode, parseRetryAfter } from './errors';
import type { AccountKind, AmountSign, CsvImport, DocumentCreated, DocumentType } from './types';

/*
 * Uploads (`POST /docs`, `POST /accounts/import`) over XMLHttpRequest,
 * because fetch cannot report upload progress. Authentication matches
 * client.ts: the same session tokens, one shared refresh and one resend on a
 * 401, then sign in again; a 401 `account_deleted` signs out at once.
 */

export interface UploadDocumentOptions {
  file: File;
  type: DocumentType;
  /**
   * A document of the same type this upload takes the place of: the API
   * retires it in the same request (spec 004 rule 24).
   */
  replaces?: string;
  /** Whole percent of the file sent, 0-100. */
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

/**
 * A failed upload: an `ApiError` (`status` 0 when the request never got an
 * answer; `retryAfterSeconds` from Retry-After on a 429), so
 * `apiErrorMessage(error, fallback)` reads it like any other request's error.
 */
export class UploadError extends ApiError {
  constructor(status: number, body: unknown, retryAfterSeconds: number | null) {
    super(status, body, retryAfterSeconds);
    this.name = 'UploadError';
  }
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
  path: string,
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
    xhr.open('POST', `${API_BASE_URL}${path}`);
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

/**
 * POST a multipart form built by `form` (called again for the resend after a
 * 401), resolving with the JSON body of a 2xx and rejecting with UploadError.
 */
async function postForm<T>(
  path: string,
  form: () => FormData,
  onProgress: ((percent: number) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<T> {
  let answer = await send(path, form(), await sessionTokens.current(), onProgress, signal);
  const deleted = () => answer.status === 401 && apiErrorCode(answer.body) === 'account_deleted';
  if (answer.status === 401 && sessionTokens.enabled()) {
    if (!deleted()) {
      const token = await sessionTokens.refreshed();
      if (token) answer = await send(path, form(), token, onProgress, signal);
    }
    if (deleted()) await sessionTokens.accountDeleted();
    else if (answer.status === 401) await sessionTokens.expire();
  }

  if (answer.status >= 200 && answer.status < 300) return answer.body as T;
  throw new UploadError(answer.status, answer.body, parseRetryAfter(answer.retryAfter));
}

/** Upload one document, or its replacement; resolves with the new document's id. */
export function uploadDocument({
  file,
  type,
  replaces,
  onProgress,
  signal,
}: UploadDocumentOptions): Promise<DocumentCreated> {
  const form = () => {
    const data = new FormData();
    data.append('type', type);
    if (replaces !== undefined) data.append('replaces', replaces);
    data.append('file', file, file.name);
    return data;
  };
  return postForm<DocumentCreated>('/docs', form, onProgress, signal);
}

/** Where a CSV import goes: a new account, or an earlier CSV import's account. */
export type CsvImportTarget =
  { id: string } | { kind: AccountKind; name?: string; institutionName?: string };

export interface ImportCsvOptions {
  file: File;
  account: CsvImportTarget;
  /** How the file's amount column is signed (ignored for debit and credit columns). */
  sign: AmountSign;
  /** Whole percent of the file sent, 0-100. */
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

/**
 * `POST /accounts/import` (spec 010 part B): a bank's CSV export through the
 * sync pipeline. Resolves with the account, the rows written and the two
 * queued jobs (categorize and recurring detection) to follow with `useJob`.
 */
export function importCsv({
  file,
  account,
  sign,
  onProgress,
  signal,
}: ImportCsvOptions): Promise<CsvImport> {
  const form = () => {
    const data = new FormData();
    data.append('file', file, file.name);
    data.append('sign', sign);
    if ('id' in account) {
      data.append('account_id', account.id);
    } else {
      data.append('kind', account.kind);
      const name = account.name?.trim();
      if (name) data.append('name', name);
      const institution = account.institutionName?.trim();
      if (institution) data.append('institution_name', institution);
    }
    return data;
  };
  return postForm<CsvImport>('/accounts/import', form, onProgress, signal);
}

/** One problem the API found in a CSV (`row` and `column` are null for the whole file). */
export interface CsvProblem {
  row: number | null;
  column: string | null;
  message: string;
}

const isProblem = (value: unknown): value is CsvProblem => {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    (p.row === null || Number.isSafeInteger(p.row)) &&
    (p.column === null || typeof p.column === 'string') &&
    typeof p.message === 'string'
  );
};

/**
 * The row errors of a 422 `csv_invalid`: the first 50 in file order and how
 * many there are in all. Null for any other error.
 */
export function csvProblems(error: unknown): { errors: CsvProblem[]; total: number } | null {
  if (!(error instanceof UploadError) || error.code !== 'csv_invalid') return null;
  const details = error.error?.details;
  const errors = details?.errors;
  const total = details?.total;
  if (!Array.isArray(errors) || !errors.every(isProblem) || !Number.isSafeInteger(total)) {
    return null;
  }
  return { errors, total: total as number };
}
