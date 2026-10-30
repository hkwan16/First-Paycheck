import { configure } from '@testing-library/react';
import { vi } from 'vitest';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/**
 * Testing Library's async wrapper, which every user-event call, `waitFor` and
 * `findBy*` runs inside, made aware of Vitest's fake timers.
 *
 * React Testing Library's own wrapper (`@testing-library/react`, pure.js) ends
 * each call by waiting for a `setTimeout(0)`, and moves the clock past it only
 * when it sees Jest's fake timers. Under Vitest's it never does, so every call
 * waited for `shouldAdvanceTime` to move the clock (up to 20 ms of real time,
 * longer on a busy machine) and hung on a clock that does not move by itself.
 * This is the same wrapper with Vitest in Jest's place: act() is off while the
 * callback runs, as React Testing Library has it, and the trailing timer fires
 * at once on a fake clock.
 */
export async function asyncWrapper<T>(cb: () => Promise<T>): Promise<T> {
  const previous = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    const result = await cb();
    // Drain the microtask queue before act() comes back on, as React Testing Library does.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
      if (vi.isFakeTimers()) vi.advanceTimersByTime(0);
    });
    return result;
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous;
  }
}

/** Install it over React Testing Library's (which configures its own on import). */
export function installAsyncWrapper() {
  configure({ asyncWrapper });
}
