import { safeNextPath } from '@/lib/auth/next-path';
import type { AuthMode } from '@/lib/routes';

export type SearchParams = Record<string, string | string[] | undefined>;

export interface SignInParams {
  mode: AuthMode;
  /** A safe relative path to return to after signing in, or null for home. */
  next: string | null;
  /** /auth/callback reported a failed email link. */
  linkError: boolean;
}

/** A query parameter given exactly once; a repeated one is ignored. */
const single = (value: string | string[] | undefined) => (typeof value === 'string' ? value : null);

/** The sign-in page's `?mode=sign-up`, `?next=<path>` and `?error=link`. */
export function parseSignInParams(params: SearchParams): SignInParams {
  return {
    mode: single(params.mode) === 'sign-up' ? 'sign-up' : 'sign-in',
    next: safeNextPath(single(params.next)),
    linkError: single(params.error) === 'link',
  };
}
