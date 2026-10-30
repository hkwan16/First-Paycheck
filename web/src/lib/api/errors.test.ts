import { describe, expect, it } from 'vitest';
import {
  ApiError,
  apiErrorCode,
  apiErrorMessage,
  formatWait,
  isApiErrorBody,
  parseRetryAfter,
  rateLimitMessage,
} from './errors';

const FALLBACK = 'Something went wrong. Try again.';

describe('apiErrorMessage', () => {
  it("reads the API's error shape", () => {
    const error = { error: { code: 'plaid_unavailable', message: 'Plaid is unavailable' } };
    expect(apiErrorMessage(error, FALLBACK)).toBe('Plaid is unavailable');
  });

  it("reads FastAPI's validation shape", () => {
    const error = { detail: [{ loc: ['path', 'item_id'], msg: 'Input should be a UUID' }] };
    expect(apiErrorMessage(error, FALLBACK)).toBe('Input should be a UUID');
  });

  // Spec 008 rule 22a, issue 162: a message naming an identifier is not for people.
  it.each([
    'emergency_fund decisions cannot be explained yet',
    'body.decision_id: Input should be a valid UUID',
    'Plaid rejected the request (INVALID_PUBLIC_TOKEN)',
  ])('shows the fallback instead of %j', (message) => {
    expect(apiErrorMessage({ error: { code: 'x', message } }, FALLBACK)).toBe(FALLBACK);
    expect(apiErrorMessage(new ApiError(422, { error: { code: 'x', message } }), FALLBACK)).toBe(
      FALLBACK,
    );
  });

  it('shows a sentence that only mentions a form or a 401(k)', () => {
    const message = 'Upload a PDF, PNG or JPEG of your W-4 or 401(k) summary';
    expect(apiErrorMessage({ error: { code: 'x', message } }, FALLBACK)).toBe(message);
  });

  it.each([[new TypeError('Failed to fetch')], [null], [undefined], ['oops'], [{ error: {} }]])(
    'falls back for %j',
    (error) => {
      expect(apiErrorMessage(error, FALLBACK)).toBe(FALLBACK);
    },
  );
});

describe('apiErrorCode', () => {
  it("reads the code of the API's error shape", () => {
    expect(apiErrorCode({ error: { code: 'decision_conflict', message: 'Reload' } })).toBe(
      'decision_conflict',
    );
  });

  it.each([[new TypeError('Failed to fetch')], [null], [{ detail: [] }], [{ error: { code: 4 } }]])(
    'is undefined for %j',
    (error) => {
      expect(apiErrorCode(error)).toBeUndefined();
    },
  );
});

describe('isApiErrorBody', () => {
  it('accepts the API error shape and nothing else', () => {
    expect(isApiErrorBody({ error: { code: 'not_found', message: 'Gone' } })).toBe(true);
    expect(isApiErrorBody({ error: { code: 'x' } })).toBe(false);
    expect(isApiErrorBody({ error: null })).toBe(false);
    expect(isApiErrorBody({ detail: [] })).toBe(false);
    expect(isApiErrorBody(null)).toBe(false);
    expect(isApiErrorBody('Not Found')).toBe(false);
  });
});

const rateLimited = {
  error: { code: 'rate_limited', message: 'Too many requests; try again in 1200 seconds' },
};

describe('ApiError', () => {
  it('keeps the status, the code, the body and when to try again', () => {
    const error = new ApiError(429, rateLimited, 1200);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: 'ApiError',
      status: 429,
      code: 'rate_limited',
      retryAfterSeconds: 1200,
      error: rateLimited.error,
    });
    expect(apiErrorCode(error)).toBe('rate_limited');
  });

  it('is readable without an API body (a proxy error page, an empty 502)', () => {
    const error = new ApiError(502, null);
    expect(error).toMatchObject({ status: 502, code: null, retryAfterSeconds: null });
    expect(apiErrorMessage(error, FALLBACK)).toBe(FALLBACK);
  });
});

describe('apiErrorMessage for limits', () => {
  it('says when to try again after a 429, from Retry-After', () => {
    expect(apiErrorMessage(new ApiError(429, rateLimited, 1200), FALLBACK)).toBe(
      'You have reached the limit for now. Try again in about 20 minutes.',
    );
    expect(apiErrorMessage(new ApiError(429, rateLimited, 61), FALLBACK)).toBe(
      'You have reached the limit for now. Try again in about 2 minutes.',
    );
  });

  it('says later when Retry-After is missing or the error is only the body', () => {
    expect(apiErrorMessage(new ApiError(429, rateLimited), FALLBACK)).toBe(
      'You have reached the limit for now. Try again later.',
    );
    expect(apiErrorMessage(rateLimited, FALLBACK)).toBe(
      'You have reached the limit for now. Try again later.',
    );
  });

  it("gives a 413 body_too_large in the API's own words", () => {
    const body = {
      error: { code: 'body_too_large', message: 'The request body is larger than 1 MB' },
    };
    expect(apiErrorMessage(new ApiError(413, body), FALLBACK)).toBe(
      'The request body is larger than 1 MB',
    );
  });
});

describe('rateLimitMessage', () => {
  it('is the one sentence every surface shows for a 429', () => {
    expect(rateLimitMessage(1200)).toBe(
      'You have reached the limit for now. Try again in about 20 minutes.',
    );
    expect(rateLimitMessage(null)).toBe('You have reached the limit for now. Try again later.');
  });
});

describe('formatWait', () => {
  it('rounds up to a phrase a person can act on', () => {
    expect(formatWait(1)).toBe('in 1 second');
    expect(formatWait(45)).toBe('in 45 seconds');
    expect(formatWait(60)).toBe('in about 1 minute');
    expect(formatWait(61)).toBe('in about 2 minutes');
    expect(formatWait(1200)).toBe('in about 20 minutes');
    expect(formatWait(3600)).toBe('in about 1 hour');
    expect(formatWait(5400)).toBe('in about 2 hours');
    expect(formatWait(0)).toBe('now');
    expect(formatWait(null)).toBe('later');
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
