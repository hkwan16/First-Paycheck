'use client';

import { useEffect } from 'react';
import { markPageHydrated } from '@/lib/page-hydration';

/**
 * Sets `data-hydrated` on <html> once the page content around it has hydrated.
 * End-to-end tests wait for it before interacting or taking screenshots, so
 * they never race React's hydration, and layout components that read the API
 * wait for it (`usePageHydrated`), so the page never hydrates with data its
 * server HTML did not have.
 *
 * Every page renders it as its last child (a test enforces this). It must sit
 * in the page, not a layout: the App Router hydrates each segment in its own
 * commit, so a layout's marker fires while the page below is still inert.
 */
export function HydrationMarker() {
  useEffect(() => {
    // Layout readers first, so a test that waits for the attribute sees them start.
    markPageHydrated();
    document.documentElement.dataset.hydrated = 'true';
  }, []);
  return null;
}
