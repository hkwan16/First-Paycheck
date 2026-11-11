import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimedOut, withTimeout } from './timeout';

afterEach(() => {
  vi.useRealTimers();
});

describe('withTimeout', () => {
  it('passes on what the promise settles with in time', async () => {
    await expect(withTimeout(Promise.resolve('session'), 1000)).resolves.toBe('session');
    await expect(withTimeout(Promise.reject(new Error('refused')), 1000)).rejects.toThrow(
      'refused',
    );
  });

  it('rejects with TimedOut once the wait is over, for a promise that never settles', async () => {
    vi.useFakeTimers();
    const waiting = withTimeout(new Promise<never>(() => undefined), 8000);
    const outcome = expect(waiting).rejects.toBeInstanceOf(TimedOut);
    await vi.advanceTimersByTimeAsync(7999);
    let settled = false;
    void waiting.catch(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
  });

  it('leaves no timer behind once the promise settles', async () => {
    vi.useFakeTimers();
    await withTimeout(Promise.resolve(1), 8000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
