import { afterEach, describe, expect, it, vi } from 'vitest';
import { landAtTopIfRequested, requestLandAtTop } from './land-at-top';

afterEach(() => vi.restoreAllMocks());

describe('landing at the top after a step link (issue 172)', () => {
  it('scrolls to the top of the page once, after a step link asked for it', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    requestLandAtTop();
    landAtTopIfRequested();
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 0);
    landAtTopIfRequested();
    expect(scrollTo).toHaveBeenCalledOnce();
  });

  it('leaves the page where it is when nothing asked', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    landAtTopIfRequested();
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
