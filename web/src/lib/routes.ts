import type { Route } from 'next';
import { safeNextPath } from './auth/next-path';

/*
 * Builders for the id-bound screens. Next's typed `Route` accepts a dynamic
 * segment only as a string literal at the call site, so links built from API
 * ids go through these functions: one place that knows the URL shape and
 * encodes the id as a single segment.
 */

function segment(id: string): string {
  if (id === '') throw new RangeError('A route id must not be empty');
  return encodeURIComponent(id);
}

export const confirmRoute = (documentId: string) =>
  `/setup/confirm/${segment(documentId)}` as Route;

export const whyRoute = (decisionId: string) => `/why/${segment(decisionId)}` as Route;

export const checkInRoute = (checkInId: string) => `/check-in/${segment(checkInId)}` as Route;

export type AuthMode = 'sign-in' | 'sign-up';

export interface SignInRouteOptions {
  mode?: AuthMode;
  /** Where to return after signing in; dropped unless it is a safe relative path. */
  next?: string | null;
  /** `link`: an email link failed (expired, used, or opened in another browser). */
  error?: 'link';
}

/**
 * The sign-in page. The return path keeps its slashes (`?next=/setup/link`)
 * so the URL stays readable; everything else in it is percent-encoded.
 */
export function signInRoute({ mode = 'sign-in', next, error }: SignInRouteOptions = {}): Route {
  const params: string[] = [];
  if (mode === 'sign-up') params.push('mode=sign-up');
  const safe = safeNextPath(next);
  if (safe) params.push(`next=${encodeURIComponent(safe).replace(/%2F/g, '/')}`);
  if (error) params.push(`error=${error}`);
  return (params.length ? `/sign-in?${params.join('&')}` : '/sign-in') as Route;
}
