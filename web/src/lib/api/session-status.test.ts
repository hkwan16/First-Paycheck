import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionStatus } from './session-status';

afterEach(() => {
  sessionStatus.report(true);
});

describe('sessionStatus (issue 225)', () => {
  it('starts readable and tells listeners only when that changes', () => {
    expect(sessionStatus.readable()).toBe(true);
    const listener = vi.fn();
    const unsubscribe = sessionStatus.subscribe(listener);

    sessionStatus.report(true);
    expect(listener).not.toHaveBeenCalled();
    sessionStatus.report(false);
    sessionStatus.report(false);
    expect(listener).toHaveBeenCalledOnce();
    expect(sessionStatus.readable()).toBe(false);

    unsubscribe();
    sessionStatus.report(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(sessionStatus.readable()).toBe(true);
  });
});
