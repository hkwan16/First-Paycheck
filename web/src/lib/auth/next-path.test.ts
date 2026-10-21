import { describe, expect, it } from 'vitest';
import { authCallbackUrl, requestPath, safeNextPath } from './next-path';

describe('safeNextPath', () => {
  it('keeps a relative path with its query and hash', () => {
    expect(safeNextPath('/setup/link')).toBe('/setup/link');
    expect(safeNextPath('/plan?tab=goals#w4')).toBe('/plan?tab=goals#w4');
    expect(safeNextPath('/setup/confirm/doc%201')).toBe('/setup/confirm/doc%201');
  });

  it('rejects anything that could leave the site', () => {
    for (const raw of [
      'https://evil.example/',
      '//evil.example/path',
      '/\\evil.example',
      '\\\\evil.example',
      'javascript:alert(1)',
      'setup/link',
      '/\t/evil.example',
      '/%0a/evil.example'.replace('%0a', '\n'),
    ]) {
      expect(safeNextPath(raw), raw).toBeNull();
    }
  });

  it('rejects missing values and the auth pages themselves (they would loop)', () => {
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
    expect(safeNextPath('')).toBeNull();
    expect(safeNextPath('/sign-in')).toBeNull();
    expect(safeNextPath('/sign-in?mode=sign-up')).toBeNull();
    expect(safeNextPath('/auth/callback?code=x')).toBeNull();
    expect(safeNextPath('/sign-in-help')).toBe('/sign-in-help');
  });

  it('normalizes dot segments before deciding', () => {
    expect(safeNextPath('/plan/../setup/link')).toBe('/setup/link');
    expect(safeNextPath('/x/../sign-in')).toBeNull();
  });
});

describe('requestPath', () => {
  it('is the pathname and query of the URL', () => {
    expect(requestPath(new URL('http://localhost:3000/setup/link'))).toBe('/setup/link');
    expect(requestPath(new URL('http://localhost:3000/plan?tab=goals'))).toBe('/plan?tab=goals');
  });

  it("drops Next's internal _rsc cache-busting parameter", () => {
    expect(requestPath(new URL('http://localhost/plan?_rsc=abc123'))).toBe('/plan');
    expect(requestPath(new URL('http://localhost/plan?tab=goals&_rsc=abc'))).toBe(
      '/plan?tab=goals',
    );
  });
});

describe('authCallbackUrl', () => {
  it('points the email link at /auth/callback on this origin', () => {
    expect(authCallbackUrl('https://app.example', null)).toBe('https://app.example/auth/callback');
  });

  it('carries a safe next path through the email link', () => {
    expect(authCallbackUrl('http://localhost:3000', '/setup/link')).toBe(
      'http://localhost:3000/auth/callback?next=%2Fsetup%2Flink',
    );
  });

  it('drops an unsafe next path', () => {
    expect(authCallbackUrl('http://localhost:3000', '//evil.example')).toBe(
      'http://localhost:3000/auth/callback',
    );
  });
});
