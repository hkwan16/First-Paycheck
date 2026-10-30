'use client';

import { useEffect, useLayoutEffect } from 'react';
import { landAtTopIfRequested } from '@/lib/land-at-top';
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
 *
 * Being in every page also makes it where a page opened by a step link lands
 * at the top (`lib/land-at-top.ts`, issue 172), before the browser paints it.
 */
export function HydrationMarker() {
  useLayoutEffect(landAtTopIfRequested, []);
  useEffect(() => {
    // Layout readers first, so a test that waits for the attribute sees them start.
    markPageHydrated();
    document.documentElement.dataset.hydrated = 'true';
  }, []);
  return null;
}
