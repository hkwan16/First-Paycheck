import { fetchClient } from './client';
import { isApiErrorBody, type ApiErrorBody } from './errors';

/*
 * File downloads from the API (spec 016): the plan's calendar file and its
 * PDF. A plain link cannot carry the bearer token, so the file is fetched
 * through the API client (the token, one shared refresh and one resend on a
 * 401, as every request) and handed to the browser through an object URL.
 */

/** The API's names (spec 016), for when its Content-Disposition cannot be read. */
export const CALENDAR_FALLBACK_FILENAME = 'first-paycheck-calendar.ics';
export const PLAN_PDF_FALLBACK_FILENAME = 'first-paycheck-plan.pdf';

/**
 * How long a saved file's object URL lives. Revoking it in the same task as
 * the click can cancel the download in Safari and Firefox; a minute is ample.
 */
export const REVOKE_AFTER_MS = 60_000;

/**
 * A failed download. `status` is 0 when the request never got an answer.
 * `error` mirrors the API body, so `apiErrorMessage(error, fallback)` reads it
 * like any other request's error (as `UploadError` does for uploads).
 */
export class DownloadError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly error: ApiErrorBody['error'] | undefined;

  constructor(status: number, body: unknown) {
    const apiError = isApiErrorBody(body) ? body.error : undefined;
    super(apiError?.message ?? (status === 0 ? 'Network error' : `Download failed (${status})`));
    this.name = 'DownloadError';
    this.status = status;
    this.code = apiError?.code ?? null;
    this.error = apiError;
  }
}

/**
 * The file name in a Content-Disposition header (`filename*=UTF-8''...`
 * first, then `filename`), without any directory part, or `fallback` when
 * there is none. A cross-origin response shows the header only when the API
 * exposes it, so the fallback is the usual case in production.
 */
export function filenameFrom(header: string | null, fallback: string): string {
  if (!header) return fallback;
  let name: string | undefined;
  const encoded = /filename\*\s*=\s*utf-8''([^;]+)/i.exec(header)?.[1];
  if (encoded) {
    try {
      name = decodeURIComponent(encoded.trim());
    } catch {
      name = undefined;
    }
  }
  if (!name) {
    const plain = /filename\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(header);
    name = plain?.[1] ?? plain?.[2];
  }
  const base = name?.split(/[/\\]/).pop()?.trim();
  return base || fallback;
}

/** Hand the browser `blob` as a download named `filename`. */
export function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  // Firefox follows only a link that is in the document.
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
  window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}

type BlobCall = Promise<{ data?: Blob; error?: unknown; response: Response }>;

/** Run a blob request, save its file, and resolve with the name it was saved under. */
async function download(call: () => BlobCall, fallback: string): Promise<string> {
  let answer: Awaited<BlobCall>;
  try {
    answer = await call();
  } catch {
    throw new DownloadError(0, null);
  }
  const { data, error, response } = answer;
  if (error !== undefined || !data) throw new DownloadError(response.status, error);
  const filename = filenameFrom(response.headers.get('Content-Disposition'), fallback);
  saveFile(data, filename);
  return filename;
}

/** `GET /plan/calendar.ics`: every decision date as an iCalendar file. */
export function downloadCalendar(): Promise<string> {
  return download(
    () => fetchClient.GET('/plan/calendar.ics', { parseAs: 'blob' }),
    CALENDAR_FALLBACK_FILENAME,
  );
}

/**
 * `GET /plan/export/{job_id}`: the PDF a succeeded `plan.export` job made. A
 * job that has not succeeded, or an export older than 7 days, is a 404.
 */
export function downloadPlanPdf(jobId: string): Promise<string> {
  return download(
    () =>
      fetchClient.GET('/plan/export/{job_id}', {
        params: { path: { job_id: jobId } },
        parseAs: 'blob',
      }),
    PLAN_PDF_FALLBACK_FILENAME,
  );
}
