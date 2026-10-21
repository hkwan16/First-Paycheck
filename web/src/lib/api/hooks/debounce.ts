import { useEffect, useState } from 'react';

/**
 * `value`, once it has stopped changing for `delayMs`. Each change restarts
 * the wait, so a slider dragged across ten stops sends one request.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}
