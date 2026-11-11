import { expect } from '@playwright/test';
import { supabaseConfigured, type E2EUser } from './auth';

/*
 * Auth failures on purpose, for the session specs. Only the local stand-in
 * for Supabase Auth (scripts/e2e_stack.py) takes faults: it exports
 * E2E_AUTH_FAULTS_URL, and faults apply to the session user alone
 * (E2E_SESSION_USER_*), so no other spec's sign-in is affected.
 */

export const NO_AUTH_FAULTS =
  'Skipped: needs the local Auth stand-in (scripts/e2e_stack.py), which sets E2E_AUTH_FAULTS_URL and E2E_SESSION_USER_EMAIL/PASSWORD.';

/** The account the session specs break, or null away from the local stack. */
export function sessionUser(): E2EUser | null {
  const email = process.env.E2E_SESSION_USER_EMAIL?.trim();
  const password = process.env.E2E_SESSION_USER_PASSWORD;
  const faults = process.env.E2E_AUTH_FAULTS_URL?.trim();
  return supabaseConfigured() && faults && email && password ? { email, password } : null;
}

export interface AuthFaults {
  /** `hang`: a token refresh gets no answer until set back to `ok` (issue 225). */
  refresh?: 'ok' | 'hang';
  /** `unavailable`: Supabase answers a sign-out with 503 (issue 224). */
  logout?: 'ok' | 'unavailable';
}

/** Make the stand-in misbehave for `user` (or behave again, with `ok`). */
export async function setAuthFaults(user: E2EUser, faults: AuthFaults) {
  const response = await fetch(process.env.E2E_AUTH_FAULTS_URL!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, ...faults }),
  });
  expect(response.status, await response.text()).toBe(200);
}
