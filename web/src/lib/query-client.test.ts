import { describe, expect, it } from 'vitest';
import { makeQueryClient } from './query-client';

describe('makeQueryClient', () => {
  it('caches for 30 seconds, retries once and does not refetch on focus', () => {
    const queries = makeQueryClient().getDefaultOptions().queries;
    expect(queries?.staleTime).toBe(30_000);
    expect(queries?.retry).toBe(1);
    expect(queries?.refetchOnWindowFocus).toBe(false);
  });

  it('never retries a mutation (saving twice is not idempotent)', () => {
    expect(makeQueryClient().getDefaultOptions().mutations?.retry).toBe(0);
  });

  it('returns a fresh client each call', () => {
    expect(makeQueryClient()).not.toBe(makeQueryClient());
  });
});
