import { useSyncExternalStore } from 'react';

/*
 * Whether the page below the layout has hydrated. The App Router hydrates
 * each segment in its own commit, layout first. A layout component that reads
 * the API as soon as it hydrates (the side nav's done marks) can fill the
 * cache before the page hydrates; the page's hooks then hydrate with data its
 * server HTML did not have, and React reports a hydration mismatch. Layout
 * readers wait for this instead.
 *
 * `HydrationMarker`, the last child of every page, marks it. It stays true
 * for the life of the document: later client navigations do not hydrate.
 */

let hydrated = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called by `HydrationMarker` once the page content has hydrated. */
export function markPageHydrated() {
  if (hydrated) return;
  hydrated = true;
  for (const listener of listeners) listener();
}

/** True once the page has hydrated; always false on the server and while hydrating. */
export function usePageHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => hydrated,
    () => false,
  );
}

/** Tests only: back to a document whose page has not hydrated. */
export function resetPageHydration() {
  hydrated = false;
}
