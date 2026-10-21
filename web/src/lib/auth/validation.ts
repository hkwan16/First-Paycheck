import type { AuthMode } from '@/lib/routes';

/** Matches the sign-in screen's "At least 12 characters" placeholder. */
export const MIN_PASSWORD_LENGTH = 12;
/** Supabase Auth rejects longer passwords (bcrypt reads only 72 bytes). */
export const MAX_PASSWORD_LENGTH = 72;

// Deliberately loose: one @, no spaces, a dot in the domain. Supabase Auth has
// the final say; this only catches typos before a round trip.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** An inline message for the email field, or null when it looks right. */
export function validateEmail(email: string): string | null {
  const value = email.trim();
  if (!value) return 'Enter your email address.';
  if (!EMAIL_SHAPE.test(value)) return 'Enter an email address like you@example.com.';
  return null;
}

/**
 * An inline message for the password field, or null. Signing in only needs a
 * password; a new account needs 12 to 72 characters.
 */
export function validatePassword(password: string, mode: AuthMode): string | null {
  if (mode === 'sign-in') return password ? null : 'Enter your password.';
  if (!password) return 'Choose a password.';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Use ${MAX_PASSWORD_LENGTH} characters or fewer.`;
  }
  return null;
}
