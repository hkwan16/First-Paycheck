import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen } from './render';

// Taken before any test fakes the clock, so it measures real time.
const realSetTimeout = globalThis.setTimeout;

function settlesWithin<T>(promise: Promise<T>, ms: number) {
  return Promise.race([
    promise.then(() => 'settled'),
    new Promise((resolve) => realSetTimeout(() => resolve('still waiting'), ms)),
  ]);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('user-event under fake timers', () => {
  it('finishes a call without waiting for the fake clock to move', async () => {
    // A clock that never moves on its own: anything left on a fake timer stays there.
    vi.useFakeTimers();
    const onClick = vi.fn();
    const { user } = renderWithProviders(
      <button type="button" onClick={onClick}>
        Save
      </button>,
      { advanceTimers: vi.advanceTimersByTime },
    );
    expect(await settlesWithin(user.click(screen.getByRole('button')), 1_000)).toBe('settled');
    expect(onClick).toHaveBeenCalledOnce();
  });
});
