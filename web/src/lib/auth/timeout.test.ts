import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimedOut } from '@/lib/timeout';
import { AUTH_TIMEOUT_MS, withAuthTimeout } from './timeout';

afterEach(() => {
  vi.useRealTimers();
});

describe('withAuthTimeout', () => {
  it('passes on what Auth answers in time', async () => {
    await expect(withAuthTimeout(Promise.resolve({ data: { user: null } }))).resolves.toEqual({
      data: { user: null },
    });
    await expect(withAuthTimeout(Promise.reject(new TypeError('fetch failed')))).rejects.toThrow(
      'fetch failed',
    );
  });

  it('gives up with TimedOut after AUTH_TIMEOUT_MS on a call Auth never answers', async () => {
    vi.useFakeTimers();
    const waiting = withAuthTimeout(new Promise<never>(() => undefined));
    const outcome = expect(waiting).rejects.toBeInstanceOf(TimedOut);
    await vi.advanceTimersByTimeAsync(AUTH_TIMEOUT_MS - 1);
    let settled = false;
    void waiting.catch(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
  });
});
