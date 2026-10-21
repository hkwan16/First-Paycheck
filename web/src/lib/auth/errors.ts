import {
  isAuthApiError,
  isAuthError,
  isAuthRetryableFetchError,
  isAuthWeakPasswordError,
} from '@supabase/supabase-js';

export const NETWORK_ERROR_MESSAGE =
  'We could not reach the sign-in service. Check your connection and try again.';

const RATE_LIMITED = 'Too many attempts. Wait a minute, then try again.';
const WEAK_PASSWORD = 'Choose a stronger password. This one is too common or too simple.';

const BY_CODE: Partial<Record<string, string>> = {
  invalid_credentials:
    'That email and password do not match. Check them and try again, or email yourself a sign-in link.',
  email_not_confirmed: 'Confirm your email first: open the link we sent you, then sign in.',
  user_already_exists: 'An account with this email already exists. Sign in instead.',
  email_exists: 'An account with this email already exists. Sign in instead.',
  weak_password: WEAK_PASSWORD,
  signup_disabled: 'New accounts are closed right now.',
  email_address_invalid: 'Supabase cannot send email to this address. Use a different one.',
  email_address_not_authorized: 'Supabase cannot send email to this address. Use a different one.',
  over_request_rate_limit: RATE_LIMITED,
  over_email_send_rate_limit: RATE_LIMITED,
};

/**
 * A sentence a person can act on for an error from Supabase Auth (or a fetch
 * that threw before reaching it). Never echoes the raw server message.
 */
export function authErrorMessage(error: unknown): string {
  if (isAuthRetryableFetchError(error) || error instanceof TypeError) return NETWORK_ERROR_MESSAGE;
  if (isAuthWeakPasswordError(error)) return WEAK_PASSWORD;
  if (isAuthError(error)) {
    const byCode = error.code ? BY_CODE[error.code] : undefined;
    if (byCode) return byCode;
    if (isAuthApiError(error) && error.status === 429) return RATE_LIMITED;
  }
  return 'Something went wrong. Try again in a moment.';
}
