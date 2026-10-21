/**
 * The "next" path: where a person returns after signing in. It travels in
 * URLs (`/sign-in?next=`, `/auth/callback?next=`), so it is untrusted input
 * and must never become an open redirect.
 */

/** Request header the proxy sets to the path being requested, read by the (app) guard. */
export const REQUEST_PATH_HEADER = 'x-first-paycheck-path';

// Any origin works: it only anchors relative parsing and is compared afterwards.
const BASE = 'http://first-paycheck.invalid';

// Returning to these after signing in would show the sign-in page again.
const AUTH_PATHS = ['/sign-in', '/auth'];

// URL parsers strip tabs and newlines, so "/\t/evil.example" would become "//evil.example".
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * `raw` as a same-site path (pathname, query and hash), or null when it is
 * missing, absolute, protocol-relative, contains backslashes or control
 * characters (which browsers may read as `//`), or points at an auth page.
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return null;
  if (raw.includes('\\') || hasControlCharacter(raw)) return null;

  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  if (AUTH_PATHS.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`))) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The path and query of a request URL, without Next's internal `_rsc` parameter. */
export function requestPath(url: URL): string {
  const search = new URLSearchParams(url.search);
  search.delete('_rsc');
  const query = search.toString();
  return query ? `${url.pathname}?${query}` : url.pathname;
}

/** The `emailRedirectTo` for magic links and sign-up confirmations. */
export function authCallbackUrl(origin: string, next: string | null): string {
  const url = new URL('/auth/callback', origin);
  const safe = safeNextPath(next);
  if (safe) url.searchParams.set('next', safe);
  return url.toString();
}
