import { describe, expect, it } from 'vitest';
import {
  encodeVerifiedUser,
  parseVerifiedUser,
  VERIFIED_USER_HEADER,
  verifiedUser,
} from './verified-user';

const alex = { id: 'u1', email: 'alex@example.com', user_metadata: { name: 'Alex' } };

describe('verifiedUser', () => {
  it('reads the user a verified JWT names: its subject, email and user metadata', () => {
    const claims = {
      iss: 'https://x.supabase.co/auth/v1',
      sub: 'u1',
      aud: 'authenticated',
      exp: 1,
      iat: 0,
      role: 'authenticated',
      aal: 'aal1' as const,
      session_id: 's1',
      email: 'alex@example.com',
      user_metadata: { name: 'Alex' },
      app_metadata: { provider: 'email' },
    };
    expect(verifiedUser(claims)).toEqual(alex);
  });

  it('gives a user without metadata an empty object, as supabase-js does', () => {
    const claims = {
      iss: '',
      sub: 'u2',
      aud: '',
      exp: 1,
      iat: 0,
      role: '',
      aal: 'aal1' as const,
      session_id: '',
    };
    expect(verifiedUser(claims)).toEqual({ id: 'u2', email: undefined, user_metadata: {} });
  });
});

describe('the verified-user header', () => {
  it('names a header only the proxy writes', () => {
    expect(VERIFIED_USER_HEADER).toBe('x-first-paycheck-user');
  });

  it('round-trips a user through a header value made only of ASCII', () => {
    const jose = {
      id: 'u3',
      email: 'jose@example.com',
      user_metadata: { full_name: 'José Ñandú 🙂' },
    };
    const value = encodeVerifiedUser(jose);
    // A header value cannot carry characters above U+00FF; new Headers() would throw.
    expect(() => new Headers({ [VERIFIED_USER_HEADER]: value })).not.toThrow();
    for (let i = 0; i < value.length; i += 1) expect(value.charCodeAt(i)).toBeLessThan(0x7f);
    expect(parseVerifiedUser(value)).toEqual(jose);
    expect(parseVerifiedUser(encodeVerifiedUser(alex))).toEqual(alex);
  });

  it('reads nothing from a missing, malformed or idless value', () => {
    expect(parseVerifiedUser(null)).toBeNull();
    expect(parseVerifiedUser('')).toBeNull();
    expect(parseVerifiedUser('not json')).toBeNull();
    expect(parseVerifiedUser('"u1"')).toBeNull();
    expect(parseVerifiedUser('{"email":"alex@example.com"}')).toBeNull();
    expect(parseVerifiedUser('{"id":""}')).toBeNull();
  });

  it('keeps only the fields the screens read, with safe defaults', () => {
    expect(parseVerifiedUser('{"id":"u1","email":5,"user_metadata":"x","role":"admin"}')).toEqual({
      id: 'u1',
      email: undefined,
      user_metadata: {},
    });
  });
});
