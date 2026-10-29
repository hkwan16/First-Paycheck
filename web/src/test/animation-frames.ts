/**
 * Resolves after the next animation frame. Frames run in the order they were
 * queued, so every callback queued before this one (Recharts' batched store
 * updates among them) has run and cleared its fallback timer by then. Files
 * that run in the node environment have no window and so no frames to wait for.
 */
export function settleAnimationFrames(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}
