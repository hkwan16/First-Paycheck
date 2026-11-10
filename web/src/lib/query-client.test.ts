import { describe, expect, it } from 'vitest';
import { SessionUnavailable } from './api/auth-middleware';
import { ApiError } from './api/errors';
import { makeQueryClient } from './query-client';

describe('makeQueryClient', () => {
  it('caches for 30 seconds, retries once and does not refetch on focus', () => {
    const queries = makeQueryClient().getDefaultOptions().queries;
    expect(queries?.staleTime).toBe(30_000);
    expect(queries?.refetchOnWindowFocus).toBe(false);
    const retry = queries?.retry as (failures: number, error: unknown) => boolean;
    expect(retry(0, new ApiError(503, null))).toBe(true);
    expect(retry(0, new TypeError('Failed to fetch'))).toBe(true);
    expect(retry(1, new ApiError(503, null))).toBe(false);
  });

  it('does not retry a read whose session could not be read (issue 225)', () => {
    // It already waited the whole session-read timeout; a retry would only double the wait.
    const retry = makeQueryClient().getDefaultOptions().queries?.retry as (
      failures: number,
      error: unknown,
    ) => boolean;
    expect(retry(0, new SessionUnavailable())).toBe(false);
  });

  it('never retries a mutation (saving twice is not idempotent)', () => {
    expect(makeQueryClient().getDefaultOptions().mutations?.retry).toBe(0);
  });

  it('returns a fresh client each call', () => {
    expect(makeQueryClient()).not.toBe(makeQueryClient());
  });
});
