import { describe, expect, it } from 'vitest';
import { ApiError } from '../errors';
import { unwrap } from './request';

const answer = (status: number, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers });

describe('unwrap', () => {
  it('resolves with the data of a success', async () => {
    await expect(
      unwrap(Promise.resolve({ data: { ok: true }, response: answer(200) })),
    ).resolves.toEqual({ ok: true });
  });

  it('throws an ApiError with the status, the body and Retry-After', async () => {
    const body = { error: { code: 'rate_limited', message: 'Too many requests' } };
    const call = Promise.resolve({
      error: body,
      response: answer(429, { 'Retry-After': '1200' }),
    });
    const error = await unwrap(call).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 429,
      code: 'rate_limited',
      retryAfterSeconds: 1200,
      error: body.error,
    });
  });

  it('lets a network failure through as it is', async () => {
    const failure = new TypeError('Failed to fetch');
    await expect(unwrap(Promise.reject(failure))).rejects.toBe(failure);
  });
});
