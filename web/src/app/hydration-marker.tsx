'use client';

import { useEffect } from 'react';

/**
 * Sets `data-hydrated` on <html> after the first client effect runs. End-to-end
 * tests wait for it before interacting or taking screenshots, so they never
 * race React's hydration.
 */
export function HydrationMarker() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = 'true';
  }, []);
  return null;
}
