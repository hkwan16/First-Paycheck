'use client';

import { useEffect } from 'react';
import { reloadPage } from '@/lib/navigation';

/** Set on <html> while a kept page waits for its reload; globals.css hides the body. */
const RESTORING = 'data-restoring';

/**
 * Keeps a signed-in page from coming back out of the browser's back/forward
 * cache (issue 224). Chrome may keep a `Cache-Control: no-store` page there
 * and show it again on Back, even after Sign out changed the session cookies,
 * so Back once showed the signed-in header, nav and data of a signed-out
 * browser. A page the browser keeps is hidden as it leaves (so it comes back
 * blank, with no flash of the old content), and one it brings back reloads,
 * so the server decides again: the screen for a signed-in person, sign-in
 * for anyone else.
 *
 * Rendered with the account menu (`HeaderAccount`), on every page that shows
 * a signed-in person's account. No `unload` listener: that would only keep
 * the page out of the cache in some browsers.
 */
export function RestoredPageGuard() {
  useEffect(() => {
    const onPageHide = (event: PageTransitionEvent) => {
      if (event.persisted) document.documentElement.setAttribute(RESTORING, '');
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) reloadPage();
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, []);
  return null;
}
