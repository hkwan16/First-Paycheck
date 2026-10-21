'use client';

import { useSyncExternalStore } from 'react';
import { formatDate, formatRelative } from '@/lib/dates';

/** How often relative times move on ("4 minutes ago" to "5 minutes ago"). */
const TICK_MS = 30_000;

let now = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  // The first subscriber after a quiet spell starts from the present.
  if (listeners.size === 0) now = Date.now();
  listeners.add(listener);
  timer ??= setInterval(() => {
    now = Date.now();
    for (const notify of listeners) notify();
  }, TICK_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

// Read once on first render, then stable until the next tick.
const getSnapshot = () => (now ||= Date.now());
const getServerSnapshot = () => null;

/**
 * "4 minutes ago" for an API timestamp, kept current while the page is open.
 * The server and the hydrating client render the plain date, so the HTML
 * never depends on whose clock rendered it; the relative form follows.
 */
export function RelativeTime({ value, className }: { value: string; className?: string }) {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return (
    <time dateTime={value} className={className}>
      {current === null ? formatDate(value) : formatRelative(value, new Date(current))}
    </time>
  );
}
