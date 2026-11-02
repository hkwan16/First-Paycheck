import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NetWorthChart } from '@/components/screens/check-in/NetWorthChart';
import { sampleNetWorth } from './fixtures/checkins';
import { settleChartUpdates } from './animation-frames';

/*
 * Recharts' store batches its updates with Redux Toolkit's autoBatchEnhancer,
 * which queues an animation frame and a 100 ms Node timer, and the first to run
 * calls the bare global `cancelAnimationFrame`. When a test file ends before
 * the frame runs, vitest closes jsdom and removes that global, the frame never
 * fires, and the timer throws "cancelAnimationFrame is not defined" into the
 * next file (CI on main, 300cfe5, limits.test.tsx).
 */

const realCancel = globalThis.cancelAnimationFrame;
afterEach(() => {
  globalThis.cancelAnimationFrame = realCancel;
});

it('settles every batched chart update while the window still exists', async () => {
  const frames = vi.spyOn(window, 'requestAnimationFrame');
  render(<NetWorthChart series={sampleNetWorth().series} />);
  cleanup();
  expect(frames).toHaveBeenCalled();

  await settleChartUpdates();

  // Stand in for the torn-down window: nothing may reach for it afterwards.
  const lateCancel = vi.fn();
  globalThis.cancelAnimationFrame = lateCancel;
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(lateCancel).not.toHaveBeenCalled();
});

/*
 * The store captures `window.requestAnimationFrame` when the chart mounts. A
 * file that mounts it under fake timers, then restores real timers in its own
 * afterEach (which runs before the shared cleanup), left the unmount's frame
 * on a clock that no longer runs and only the 100 ms timer to fire (CI on PR
 * 192, limits.test.tsx).
 */
it('settles a chart mounted under fake timers and unmounted after real ones return', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<NetWorthChart series={sampleNetWorth().series} />);
  // Let the chart settle on the fake clock, as a screen test does before it ends.
  await act(() => vi.advanceTimersByTimeAsync(50));
  vi.useRealTimers();
  cleanup();

  await settleChartUpdates();

  const lateCancel = vi.fn();
  globalThis.cancelAnimationFrame = lateCancel;
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(lateCancel).not.toHaveBeenCalled();
});
