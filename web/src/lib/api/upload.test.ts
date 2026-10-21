import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeXhr } from '@/test/fake-xhr';
import { API_BASE_URL } from './base-url';
import { apiErrorMessage } from './errors';
import { parseRetryAfter, UploadError, uploadDocument } from './upload';

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
const pdf = () => new File(['%PDF-1.7 synthetic'], 'acme.pdf', { type: 'application/pdf' });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let xhr: ReturnType<typeof installFakeXhr>;
beforeEach(() => {
  xhr = installFakeXhr();
  mocks.getSupabaseBrowserClient.mockReturnValue(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('uploadDocument', () => {
  it('posts the file and its type as multipart and returns the new document id', async () => {
    const done = uploadDocument({ file: pdf(), type: 'pay_stub' });
    await flush();
    const request = xhr.last();
    expect(request.method).toBe('POST');
    expect(request.url).toBe(`${API_BASE_URL}/docs`);
    expect(request.field('type')).toBe('pay_stub');
    expect((request.field('file') as File).name).toBe('acme.pdf');
    expect(request.headers.authorization).toBeUndefined();

    request.respond(201, { document_id: 'doc-1' });
    await expect(done).resolves.toEqual({ document_id: 'doc-1' });
  });

  it('reports upload progress as a whole percent', async () => {
    const progress: number[] = [];
    const done = uploadDocument({
      file: pdf(),
      type: 'pay_stub',
      onProgress: (p) => progress.push(p),
    });
    await flush();
    xhr.last().progress(1, 3);
    xhr.last().progress(3, 3);
    xhr.last().respond(201, { document_id: 'doc-1' });
    await done;
    expect(progress).toEqual([33, 100]);
  });

  it('sends the session token as a bearer header', async () => {
    mocks.getSupabaseBrowserClient.mockReturnValue({ auth: mocks.auth });
    mocks.auth.getSession.mockResolvedValue(sessionWith('access-1'));
    const done = uploadDocument({ file: pdf(), type: 'benefits' });
    await flush();
    expect(xhr.last().headers.authorization).toBe('Bearer access-1');
    xhr.last().respond(201, { document_id: 'doc-2' });
    await expect(done).resolves.toEqual({ document_id: 'doc-2' });
  });

  it('on a 401 refreshes once and sends the file again with the new token', async () => {
    mocks.getSupabaseBrowserClient.mockReturnValue({ auth: mocks.auth });
    mocks.auth.getSession.mockResolvedValue(sessionWith('access-1'));
    mocks.auth.refreshSession.mockResolvedValue(sessionWith('access-2'));
    const done = uploadDocument({ file: pdf(), type: 'pay_stub' });
    await flush();
    xhr.last().respond(401, { error: { code: 'unauthorized', message: 'expired' } });
    await vi.waitFor(() => expect(xhr.requests).toHaveLength(2));
    expect(xhr.last().headers.authorization).toBe('Bearer access-2');
    expect((xhr.last().field('file') as File).name).toBe('acme.pdf');
    xhr.last().respond(201, { document_id: 'doc-3' });
    await expect(done).resolves.toEqual({ document_id: 'doc-3' });
    expect(mocks.hardNavigate).not.toHaveBeenCalled();
  });

  it('signs out and goes to sign in after a second 401', async () => {
    mocks.getSupabaseBrowserClient.mockReturnValue({ auth: mocks.auth });
    mocks.auth.getSession.mockResolvedValue(sessionWith('access-1'));
    mocks.auth.refreshSession.mockResolvedValue(sessionWith('access-2'));
    mocks.auth.signOut.mockResolvedValue({ error: null });
    const done = uploadDocument({ file: pdf(), type: 'pay_stub' });
    await flush();
    xhr.last().respond(401, null);
    await vi.waitFor(() => expect(xhr.requests).toHaveLength(2));
    xhr.last().respond(401, null);
    await expect(done).rejects.toMatchObject({ status: 401 });
    expect(mocks.auth.signOut).toHaveBeenCalledOnce();
    expect(mocks.hardNavigate).toHaveBeenCalledOnce();
  });

  it.each([
    [413, 'file_too_large', 'The file is larger than 10 MB'],
    [415, 'unsupported_media_type', 'Upload a PDF, PNG or JPEG'],
    [422, 'empty_file', 'The file is empty'],
  ])(
    'rejects a %i with the API error, readable by apiErrorMessage',
    async (status, code, message) => {
      const done = uploadDocument({ file: pdf(), type: 'pay_stub' });
      await flush();
      xhr.last().respond(status, { error: { code, message } });
      const error = await done.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UploadError);
      expect(error).toMatchObject({ status, code, retryAfterSeconds: null });
      expect(apiErrorMessage(error, 'fallback')).toBe(message);
    },
  );

  it('reads Retry-After from a 429', async () => {
    const done = uploadDocument({ file: pdf(), type: 'pay_stub' });
    await flush();
    xhr.last().respond(
      429,
      {
        error: { code: 'rate_limited', message: 'Too many requests; try again in 1200 seconds' },
      },
      { 'Retry-After': '1200' },
    );
    await expect(done).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
      retryAfterSeconds: 1200,
    });
  });

  it('rejects a network failure with status 0 and no API message', async () => {
    const done = uploadDocument({ file: pdf(), type: 'pay_stub' });
    await flush();
    xhr.last().fail();
    const error = await done.catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 0, code: null });
    expect(apiErrorMessage(error, 'Check your connection.')).toBe('Check your connection.');
  });

  it('aborts the request when the signal fires', async () => {
    const controller = new AbortController();
    const done = uploadDocument({ file: pdf(), type: 'pay_stub', signal: controller.signal });
    await flush();
    controller.abort();
    await expect(done).rejects.toMatchObject({ name: 'AbortError' });
    expect(xhr.last().aborted).toBe(true);
  });
});

describe('parseRetryAfter', () => {
  const now = new Date('2026-10-17T16:00:00Z');
  it('reads delay seconds and HTTP dates, and nothing else', () => {
    expect(parseRetryAfter('120', now)).toBe(120);
    expect(parseRetryAfter('Sat, 17 Oct 2026 16:05:00 GMT', now)).toBe(300);
    expect(parseRetryAfter('Sat, 17 Oct 2026 15:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter('-5', now)).toBeNull();
  });
});
