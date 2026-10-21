/**
 * A full document navigation, used when the session changes (sign in, sign
 * out, an expired session). Unlike a client-side router push it re-renders
 * every server component with the new cookies and drops all client state,
 * including the previous person's React Query cache.
 *
 * Its own module so tests can mock it: jsdom cannot navigate documents.
 */
export function hardNavigate(url: string): void {
  window.location.assign(url);
}
