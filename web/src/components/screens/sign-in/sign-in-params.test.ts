import { describe, expect, it } from 'vitest';
import { parseSignInParams } from './sign-in-params';

describe('parseSignInParams', () => {
  it('defaults to signing in, home afterwards, no error', () => {
    expect(parseSignInParams({})).toEqual({
      mode: 'sign-in',
      next: null,
      linkError: false,
      deleted: false,
    });
  });

  it('reads ?mode=sign-up, a safe next path and ?error=link', () => {
    expect(parseSignInParams({ mode: 'sign-up', next: '/setup/link', error: 'link' })).toEqual({
      mode: 'sign-up',
      next: '/setup/link',
      linkError: true,
      deleted: false,
    });
  });

  it('ignores unknown values, unsafe paths and repeated parameters', () => {
    expect(
      parseSignInParams({ mode: 'admin', next: 'https://evil.example', error: 'other' }),
    ).toEqual({ mode: 'sign-in', next: null, linkError: false, deleted: false });
    expect(parseSignInParams({ mode: ['sign-up', 'sign-up'], next: ['/plan', '/plan'] })).toEqual({
      mode: 'sign-in',
      next: null,
      linkError: false,
      deleted: false,
    });
  });

  it('reads ?deleted=1, and nothing else, as the account having been deleted', () => {
    expect(parseSignInParams({ deleted: '1' }).deleted).toBe(true);
    expect(parseSignInParams({ deleted: 'yes' }).deleted).toBe(false);
    expect(parseSignInParams({ deleted: ['1', '1'] }).deleted).toBe(false);
  });
});
