/*
 * A step link (`StepFooter`'s Back and next) lands the next page at the top
 * (issue 172). Next's App Router scrolls only when the changed segment's top
 * edge is out of view. Following a link at the bottom of a long step, the
 * browser first clamps the scroll offset to the new page, which is still
 * short while its cards load; the new page's top edge is then in view, so
 * Next leaves it there, and on a phone the collapsed nav button above it
 * sits under the sticky header. A step change is a new page, so it starts
 * at the top.
 *
 * The link asks (`onNavigate`, with Next's own scroll off); the new page's
 * `HydrationMarker`, which every page renders as its last child, scrolls once
 * its content is in place. Back and forward, reloads and every other link
 * keep the browser's and Next's scrolling.
 */

let requested = false;

/** A step link's `onNavigate`: the page it opens starts at the top. */
export function requestLandAtTop() {
  requested = true;
}

/** Called as a new page's content commits: scroll to the top if a step link asked. */
export function landAtTopIfRequested() {
  if (!requested) return;
  requested = false;
  window.scrollTo(0, 0);
}
