/**
 * How long Redux Toolkit's autoBatchEnhancer (inside Recharts' store) waits
 * before its fallback timer notifies, when the animation frame it queued has
 * not run. Whichever runs first calls the bare global `cancelAnimationFrame`.
 */
export const BATCH_FALLBACK_MS = 100;

/**
 * Resolves once every batched chart update queued so far has run while the
 * window still exists. A frame is not enough: a chart mounted under fake timers
 * keeps the fake `requestAnimationFrame`, and once real timers are back that
 * frame never runs, leaving only the fallback timer. Timers with the same delay
 * run in the order they were set, so every fallback set before this one has
 * fired by the time it resolves. Files that run in the node environment have
 * no window and nothing to wait for.
 */
export function settleChartUpdates(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, BATCH_FALLBACK_MS);
  });
}
