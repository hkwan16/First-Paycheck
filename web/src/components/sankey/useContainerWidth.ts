'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * The width the server renders the diagram at: the Spending screen's main
 * column inside a card at a 1280 px window. The client measures the real
 * width right after hydrating.
 */
export const SSR_WIDTH = 928;

/**
 * The element's content width in whole pixels, kept current with a
 * ResizeObserver (measured once where there is none). A zero width (not laid
 * out yet, or hidden) is ignored.
 */
export function useContainerWidth<T extends HTMLElement>() {
  const [element, setElement] = useState<T | null>(null);
  const [width, setWidth] = useState(SSR_WIDTH);

  useEffect(() => {
    if (!element) return;
    const measure = () => {
      const next = Math.floor(element.clientWidth);
      if (next > 0) setWidth(next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  const ref = useCallback((el: T | null) => setElement(el), []);
  return { ref, width };
}
