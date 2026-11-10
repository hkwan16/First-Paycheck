/** Where the account menu's Sign out posts (`app/auth/sign-out/route.ts`). */
export const SIGN_OUT_PATH = '/auth/sign-out';

/**
 * How long sign-out waits for Supabase to end the session before it signs
 * the browser out anyway. Supabase answers in well under a second; this only
 * bounds a call that gets no answer at all.
 */
export const SIGN_OUT_TIMEOUT_MS = 5000;

// supabase-js stores the session as `sb-<project ref>-auth-token`, which
// @supabase/ssr splits into `.0`, `.1`... chunks, plus a PKCE code verifier.
const AUTH_COOKIE = /^sb-.+-auth-token(?:\.\d+|-code-verifier)?$/;

/** True for a cookie that holds (part of) a Supabase session. */
export const isAuthCookie = (name: string) => AUTH_COOKIE.test(name);
