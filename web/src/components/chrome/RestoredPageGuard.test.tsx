import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ reloadPage: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ reloadPage: mocks.reloadPage }));

import { RestoredPageGuard } from './RestoredPageGuard';

/** A page leaving or coming back; `persisted` means through the back/forward cache. */
function transition(type: 'pagehide' | 'pageshow', persisted: boolean) {
  const event = new Event(type);
  Object.defineProperty(event, 'persisted', { value: persisted });
  window.dispatchEvent(event);
}

const hidden = () => document.documentElement.hasAttribute('data-restoring');

afterEach(() => {
  document.documentElement.removeAttribute('data-restoring');
  vi.clearAllMocks();
});

describe('RestoredPageGuard (issue 224)', () => {
  it('hides a signed-in page as the browser keeps it, so it comes back blank', () => {
    render(<RestoredPageGuard />);
    transition('pagehide', true);
    expect(hidden()).toBe(true);
  });

  it('reloads a page the browser brings back, so the server decides what it shows', () => {
    render(<RestoredPageGuard />);
    transition('pagehide', true);
    transition('pageshow', true);
    expect(mocks.reloadPage).toHaveBeenCalledOnce();
    // It stays hidden while the reload loads.
    expect(hidden()).toBe(true);
  });

  it('leaves an ordinary load and an unload the browser does not keep alone', () => {
    render(<RestoredPageGuard />);
    transition('pageshow', false);
    transition('pagehide', false);
    expect(mocks.reloadPage).not.toHaveBeenCalled();
    expect(hidden()).toBe(false);
  });

  it('stops listening once it leaves the page', () => {
    const { unmount } = render(<RestoredPageGuard />);
    unmount();
    transition('pagehide', true);
    transition('pageshow', true);
    expect(mocks.reloadPage).not.toHaveBeenCalled();
    expect(hidden()).toBe(false);
  });
});
