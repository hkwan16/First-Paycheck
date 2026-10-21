import { describe, expect, it } from 'vitest';
import { MIN_PASSWORD_LENGTH, validateEmail, validatePassword } from './validation';

describe('validateEmail', () => {
  it('asks for an email when it is blank', () => {
    expect(validateEmail('')).toBe('Enter your email address.');
    expect(validateEmail('   ')).toBe('Enter your email address.');
  });

  it('rejects text that is not shaped like an address', () => {
    for (const email of ['alex', 'alex@', '@example.com', 'alex@example', 'a b@example.com']) {
      expect(validateEmail(email), email).toBe('Enter an email address like you@example.com.');
    }
  });

  it('accepts an address, ignoring surrounding spaces', () => {
    expect(validateEmail('alex@example.com')).toBeNull();
    expect(validateEmail('  alex.rivera+pay@mail.example.co  ')).toBeNull();
  });
});

describe('validatePassword', () => {
  it('only requires a password to sign in (older accounts may have shorter ones)', () => {
    expect(validatePassword('', 'sign-in')).toBe('Enter your password.');
    expect(validatePassword('short', 'sign-in')).toBeNull();
  });

  it('requires at least 12 characters for a new account', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(validatePassword('', 'sign-up')).toBe('Choose a password.');
    expect(validatePassword('elevenchars', 'sign-up')).toBe('Use at least 12 characters.');
    expect(validatePassword('twelve chars', 'sign-up')).toBeNull();
  });

  it('caps a new password at 72 characters, the Supabase Auth limit', () => {
    expect(validatePassword('x'.repeat(72), 'sign-up')).toBeNull();
    expect(validatePassword('x'.repeat(73), 'sign-up')).toBe('Use 72 characters or fewer.');
  });
});
