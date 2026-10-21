/**
 * The screens behind the sign-in guard: every page in the `(app)` route
 * group. The proxy redirects a signed-out request for one of these before it
 * renders; `protected.test.ts` fails when a new `(app)` page is not covered.
 */
const SIGNED_IN_PREFIXES = ['/setup', '/why', '/plan', '/check-in'] as const;

/** Whether `pathname` is a signed-in screen. Whole segments only: `/planner` is not `/plan`. */
export function requiresSignIn(pathname: string): boolean {
  return SIGNED_IN_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
