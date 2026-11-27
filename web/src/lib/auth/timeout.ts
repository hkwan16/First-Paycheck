import { withTimeout } from '@/lib/timeout';

/**
 * How long a call to Supabase Auth waits before it is given up on (issues
 * 225 and 288): a session read or refresh in the browser, `getUser()` and a
 * code exchange on the server, a sign-in request from the form. supabase-js
 * sends each with no timeout of its own; a healthy answer takes well under a
 * second. Each caller states what happens when it runs out.
 */
export const AUTH_TIMEOUT_MS = 10_000;

/** `call`, or a `TimedOut` rejection after `AUTH_TIMEOUT_MS`, whichever comes first. */
export function withAuthTimeout<T>(call: Promise<T>): Promise<T> {
  return withTimeout(call, AUTH_TIMEOUT_MS);
}
