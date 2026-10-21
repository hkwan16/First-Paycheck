import { describe, expect, it } from 'vitest';
import { checkInRoute, confirmRoute, whyRoute } from './routes';

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
