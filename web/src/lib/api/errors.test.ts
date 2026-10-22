import { describe, expect, it } from 'vitest';
import { apiErrorCode, apiErrorMessage, isApiErrorBody } from './errors';

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
