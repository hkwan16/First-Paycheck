import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE_URL } from './base-url';
import {
  CALENDAR_FALLBACK_FILENAME,
  downloadCalendar,
  DownloadError,
  downloadPlanPdf,
  filenameFrom,
  PLAN_PDF_FALLBACK_FILENAME,
  REVOKE_AFTER_MS,
  saveFile,
} from './download';
import { apiErrorMessage } from './errors';
import { watchDownloads } from '@/test/fake-download';

const mocks = vi.hoisted(() => {
  const auth = { getSession: vi.fn(), refreshSession: vi.fn(), signOut: vi.fn() };
  return {
    auth,
    getSupabaseBrowserClient: vi.fn((): { auth: typeof auth } | null => null),
    hardNavigate: vi.fn(),
  };
});
vi.mock('@/lib/supabase/client', () => ({
  getSupabaseBrowserClient: mocks.getSupabaseBrowserClient,
}));
vi.mock('@/lib/navigation', () => ({ hardNavigate: mocks.hardNavigate }));

const sessionWith = (token: string) => ({
  data: { session: { access_token: token } },
  error: null,
});

const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';

/** A stand-in for fetch that records each request and answers from `answers`, in order. */
function fakeFetch(...answers: (() => Response)[]) {
  const requests: Request[] = [];
  const fetch = vi.fn(async (request: Request) => {
    requests.push(request);
    const answer = answers[Math.min(requests.length, answers.length) - 1];
    return answer!();
  });
  vi.stubGlobal('fetch', fetch);
  return requests;
}

const file = (body: BodyInit, type: string, disposition?: string) => () =>
  new Response(body, {
    headers: {
      'Content-Type': type,
      ...(disposition ? { 'Content-Disposition': disposition } : {}),
    },
  });

const apiError = (status: number, code: string, message: string) => () =>
  Response.json({ error: { code, message } }, { status });

let downloads: ReturnType<typeof watchDownloads> | undefined;
const watch = () => (downloads = watchDownloads());

beforeEach(() => mocks.getSupabaseBrowserClient.mockReturnValue(null));
afterEach(() => {
  downloads?.restore();
  downloads = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('filenameFrom', () => {
  it('reads a quoted, a bare and an RFC 5987 file name', () => {
    expect(filenameFrom('attachment; filename="plan.pdf"', 'x')).toBe('plan.pdf');
    expect(filenameFrom('attachment; filename=plan.pdf', 'x')).toBe('plan.pdf');
    expect(filenameFrom("attachment; filename*=UTF-8''pl%C3%A1n.pdf", 'x')).toBe('plán.pdf');
  });

  it('falls back when the header is missing, unreadable or names a path', () => {
    expect(filenameFrom(null, 'fallback.ics')).toBe('fallback.ics');
    expect(filenameFrom('attachment', 'fallback.ics')).toBe('fallback.ics');
    expect(filenameFrom('attachment; filename=""', 'fallback.ics')).toBe('fallback.ics');
    expect(filenameFrom('attachment; filename="../etc/passwd"', 'fallback.ics')).toBe('passwd');
  });
});

describe('saveFile', () => {
  it('hands the browser the file through an object URL, then lets the URL go', () => {
    vi.useFakeTimers();
    const { clicks, revoked } = watch();
    const blob = new Blob(['hello'], { type: 'text/plain' });
    saveFile(blob, 'hello.txt');
    expect(clicks).toEqual([
      { href: 'blob:http://localhost/1', download: 'hello.txt', attached: true },
    ]);
    expect(document.querySelector('a[download]')).toBeNull();
    // Revoking at once can cancel the download in some browsers.
    expect(revoked).not.toHaveBeenCalled();
    vi.advanceTimersByTime(REVOKE_AFTER_MS);
    expect(revoked).toHaveBeenCalledWith('blob:http://localhost/1');
  });
});

describe('downloadCalendar', () => {
  it('reads the .ics and saves it under the name the API gives', async () => {
    const requests = fakeFetch(
      file(
        ICS,
        'text/calendar; charset=utf-8',
        'attachment; filename="first-paycheck-calendar.ics"',
      ),
    );
    const { clicks, blobs } = watch();

    await expect(downloadCalendar()).resolves.toBe('first-paycheck-calendar.ics');
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${API_BASE_URL}/plan/calendar.ics`,
    ]);
    expect(requests[0]!.headers.get('Authorization')).toBeNull();
    expect(clicks.map((c) => c.download)).toEqual(['first-paycheck-calendar.ics']);
    expect(blobs[0]!.type).toBe('text/calendar;charset=utf-8');
    expect(await blobs[0]!.text()).toBe(ICS);
  });

  it('uses its own name when the API’s header is not readable (cross-origin)', async () => {
    fakeFetch(file(ICS, 'text/calendar; charset=utf-8'));
    const { clicks } = watch();
    await expect(downloadCalendar()).resolves.toBe(CALENDAR_FALLBACK_FILENAME);
    expect(clicks.map((c) => c.download)).toEqual([CALENDAR_FALLBACK_FILENAME]);
  });

  it('sends the session token, and refreshes it once on a 401', async () => {
    mocks.getSupabaseBrowserClient.mockReturnValue({ auth: mocks.auth });
    mocks.auth.getSession.mockResolvedValue(sessionWith('access-1'));
    mocks.auth.refreshSession.mockResolvedValue(sessionWith('access-2'));
    const requests = fakeFetch(
      apiError(401, 'unauthorized', 'Sign in again'),
      file(ICS, 'text/calendar'),
    );
    watch();
    await downloadCalendar();
    expect(requests.map((r) => r.headers.get('Authorization'))).toEqual([
      'Bearer access-1',
      'Bearer access-2',
    ]);
  });

  it('fails with the API’s error and saves nothing', async () => {
    fakeFetch(apiError(500, 'internal_error', 'Something went wrong.'));
    const { clicks } = watch();
    const error = await downloadCalendar().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DownloadError);
    expect(error).toMatchObject({ status: 500, code: 'internal_error' });
    expect(apiErrorMessage(error, 'fallback')).toBe('Something went wrong.');
    expect(clicks).toEqual([]);
  });

  it('fails with status 0 when the API cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const { clicks } = watch();
    const error = await downloadCalendar().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DownloadError);
    expect(error).toMatchObject({ status: 0, code: null });
    expect(apiErrorMessage(error, 'Could not reach the server.')).toBe(
      'Could not reach the server.',
    );
    expect(clicks).toEqual([]);
  });
});

describe('downloadPlanPdf', () => {
  const JOB_ID = '5e000000-0000-4000-8000-000000000001';

  it('reads the finished export by its job id and saves the PDF', async () => {
    const requests = fakeFetch(
      file(
        '%PDF-1.7',
        'application/pdf',
        'attachment; filename="first-paycheck-plan-2026-10-17.pdf"',
      ),
    );
    const { clicks, blobs } = watch();
    await expect(downloadPlanPdf(JOB_ID)).resolves.toBe('first-paycheck-plan-2026-10-17.pdf');
    expect(requests[0]!.url).toBe(`${API_BASE_URL}/plan/export/${JOB_ID}`);
    expect(clicks.map((c) => c.download)).toEqual(['first-paycheck-plan-2026-10-17.pdf']);
    expect(blobs[0]!.type).toBe('application/pdf');
  });

  it('falls back to a plain name without the header', async () => {
    fakeFetch(file('%PDF-1.7', 'application/pdf'));
    watch();
    await expect(downloadPlanPdf(JOB_ID)).resolves.toBe(PLAN_PDF_FALLBACK_FILENAME);
  });

  it('reports an export that is gone or not finished as not_found', async () => {
    fakeFetch(apiError(404, 'not_found', 'Export not found'));
    watch();
    await expect(downloadPlanPdf(JOB_ID)).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });
});
