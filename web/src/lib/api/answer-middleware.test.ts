import { http, HttpResponse } from 'msw';
import createFetchClient from 'openapi-fetch';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/msw/server';
import { answerMiddleware, NoApiAnswer } from './answer-middleware';
import { ApiError, apiErrorCode, apiErrorMessage } from './errors';

const BASE = 'http://api.test';

interface Paths {
  '/ping': {
    get: { responses: { 200: { content: { 'application/json': { ok: boolean } } } } };
    delete: { responses: { 204: { content: never } } };
  };
}

function client() {
  const fetchClient = createFetchClient<Paths>({
    baseUrl: BASE,
    fetch: (request) => globalThis.fetch(request),
  });
  fetchClient.use(answerMiddleware);
  return fetchClient;
}

describe('answerMiddleware (issue 289)', () => {
  it('rejects a non-2xx answer with no body as an ApiError with the status and no code', async () => {
    server.use(http.get(`${BASE}/ping`, () => new HttpResponse(null, { status: 502 })));
    const error: unknown = await client()
      .GET('/ping')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoApiAnswer);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 502,
      code: null,
      error: undefined,
      message: 'The API did not answer (502)',
    });
    // Not the API's answer: a screen's fallback, and (issue 258) a load to try again.
    expect(apiErrorCode(error)).toBeUndefined();
    expect(apiErrorMessage(error, 'Could not load.')).toBe('Could not load.');
  });

  it('rejects a non-2xx answer whose body is not the API shape, such as a host page', async () => {
    server.use(
      http.get(`${BASE}/ping`, () =>
        HttpResponse.html('<html>Bad Gateway</html>', { status: 502 }),
      ),
    );
    await expect(client().GET('/ping')).rejects.toMatchObject({
      name: 'NoApiAnswer',
      status: 502,
      code: null,
    });
  });

  it('lets a non-2xx answer in the API shape through, body and all', async () => {
    server.use(
      http.get(`${BASE}/ping`, () =>
        HttpResponse.json({ error: { code: 'unavailable', message: 'db down' } }, { status: 502 }),
      ),
    );
    const { data, error, response } = await client().GET('/ping');
    expect(data).toBeUndefined();
    expect(response.status).toBe(502);
    expect(error).toEqual({ error: { code: 'unavailable', message: 'db down' } });
  });

  it('leaves a 200 alone', async () => {
    server.use(http.get(`${BASE}/ping`, () => HttpResponse.json({ ok: true })));
    const { data, error } = await client().GET('/ping');
    expect(error).toBeUndefined();
    expect(data).toEqual({ ok: true });
  });

  it('leaves a 204 with no body alone', async () => {
    server.use(http.delete(`${BASE}/ping`, () => new HttpResponse(null, { status: 204 })));
    const { data, error, response } = await client().DELETE('/ping');
    expect(response.status).toBe(204);
    expect(error).toBeUndefined();
    expect(data).toBeUndefined();
  });
});
