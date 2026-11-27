import type { JwtPayload, User } from '@supabase/supabase-js';

/**
 * Request header the proxy sets to the user named by the JWT it verified with
 * `getClaims()`, read by `getCurrentUser()` when Supabase Auth does not answer
 * `getUser()` in time (issue 288). The proxy sets or removes it on every
 * request it handles, so a value the browser sent never reaches the app.
 */
export const VERIFIED_USER_HEADER = 'x-first-paycheck-user';

/** What the screens read of the signed-in user: the guard an id, the header a name or email. */
export type CurrentUser = Pick<User, 'id' | 'email' | 'user_metadata'>;

/** The user a verified JWT names. */
export function verifiedUser(claims: JwtPayload): CurrentUser {
  return { id: claims.sub, email: claims.email, user_metadata: claims.user_metadata ?? {} };
}

/** The header's value: JSON in ASCII, since a header value cannot carry characters above U+00FF. */
export function encodeVerifiedUser(user: CurrentUser): string {
  return JSON.stringify(user).replace(
    /[^\x20-\x7e]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** The user a header value names, or null when it is missing or not one `encodeVerifiedUser` wrote. */
export function parseVerifiedUser(value: string | null): CurrentUser | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.id !== 'string' || parsed.id === '') return null;
  return {
    id: parsed.id,
    email: typeof parsed.email === 'string' ? parsed.email : undefined,
    user_metadata: isRecord(parsed.user_metadata) ? parsed.user_metadata : {},
  };
}
