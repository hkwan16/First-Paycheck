import { describe, expect, it } from 'vitest';
import { checkInRoute, confirmRoute, signInRoute, whyRoute } from './routes';

describe('route builders', () => {
  it('build the id-bound screen paths', () => {
    expect(confirmRoute('doc_1')).toBe('/setup/confirm/doc_1');
    expect(whyRoute('dec_1')).toBe('/why/dec_1');
    expect(checkInRoute('ci_1')).toBe('/check-in/ci_1');
  });

  it('encode ids so they stay one path segment', () => {
    expect(confirmRoute('a/b?c')).toBe('/setup/confirm/a%2Fb%3Fc');
  });

  it('reject an empty id', () => {
    expect(() => whyRoute('')).toThrow(RangeError);
  });
});

describe('signInRoute', () => {
  it('is plain /sign-in by default', () => {
    expect(signInRoute()).toBe('/sign-in');
    expect(signInRoute({ mode: 'sign-in', next: null })).toBe('/sign-in');
  });

  it('keeps the slashes of the return path readable', () => {
    expect(signInRoute({ next: '/setup/link' })).toBe('/sign-in?next=/setup/link');
    expect(signInRoute({ next: '/plan?tab=a&b=c' })).toBe('/sign-in?next=/plan%3Ftab%3Da%26b%3Dc');
  });

  it('adds the sign-up mode and the link error flag', () => {
    expect(signInRoute({ mode: 'sign-up', next: '/plan' })).toBe(
      '/sign-in?mode=sign-up&next=/plan',
    );
    expect(signInRoute({ error: 'link' })).toBe('/sign-in?error=link');
  });

  it('drops a return path that is not a safe relative path', () => {
    expect(signInRoute({ next: 'https://evil.example' })).toBe('/sign-in');
  });
});
