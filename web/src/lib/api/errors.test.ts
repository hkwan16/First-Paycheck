import { describe, expect, it } from 'vitest';
import { apiErrorMessage } from './errors';

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
