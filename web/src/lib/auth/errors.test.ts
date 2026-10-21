import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthWeakPasswordError,
} from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { authErrorMessage, NETWORK_ERROR_MESSAGE } from './errors';

const apiError = (message: string, status: number, code: string) =>
  new AuthApiError(message, status, code);

describe('authErrorMessage', () => {
  it('explains a wrong email or password without saying which one', () => {
    expect(
      authErrorMessage(apiError('Invalid login credentials', 400, 'invalid_credentials')),
    ).toBe(
      'That email and password do not match. Check them and try again, or email yourself a sign-in link.',
    );
  });

  it('treats an unreachable Auth service or a thrown fetch as a network problem', () => {
    expect(authErrorMessage(new AuthRetryableFetchError('Failed to fetch', 0))).toBe(
      NETWORK_ERROR_MESSAGE,
    );
    expect(authErrorMessage(new TypeError('Failed to fetch'))).toBe(NETWORK_ERROR_MESSAGE);
    expect(NETWORK_ERROR_MESSAGE).toBe(
      'We could not reach the sign-in service. Check your connection and try again.',
    );
  });

  it('maps the account states a person can fix', () => {
    expect(authErrorMessage(apiError('Email not confirmed', 400, 'email_not_confirmed'))).toBe(
      'Confirm your email first: open the link we sent you, then sign in.',
    );
    expect(authErrorMessage(apiError('User already registered', 422, 'user_already_exists'))).toBe(
      'An account with this email already exists. Sign in instead.',
    );
    expect(
      authErrorMessage(new AuthWeakPasswordError('Password is known to be weak', 422, ['pwned'])),
    ).toBe('Choose a stronger password. This one is too common or too simple.');
    expect(authErrorMessage(apiError('Signups not allowed', 422, 'signup_disabled'))).toBe(
      'New accounts are closed right now.',
    );
    expect(authErrorMessage(apiError('Invalid email', 400, 'email_address_invalid'))).toBe(
      'Supabase cannot send email to this address. Use a different one.',
    );
  });

  it('asks the person to wait when rate limited', () => {
    for (const code of ['over_request_rate_limit', 'over_email_send_rate_limit']) {
      expect(authErrorMessage(apiError('rate limited', 429, code))).toBe(
        'Too many attempts. Wait a minute, then try again.',
      );
    }
    expect(authErrorMessage(apiError('slow down', 429, ''))).toBe(
      'Too many attempts. Wait a minute, then try again.',
    );
  });

  it('falls back to a generic message for anything else', () => {
    expect(authErrorMessage(apiError('boom', 500, 'unexpected_failure'))).toBe(
      'Something went wrong. Try again in a moment.',
    );
    expect(authErrorMessage('???')).toBe('Something went wrong. Try again in a moment.');
  });
});
