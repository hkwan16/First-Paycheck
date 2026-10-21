import { act, renderHook } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { markPageHydrated, resetPageHydration, usePageHydrated } from './page-hydration';

afterEach(() => resetPageHydration());

function Probe() {
  return usePageHydrated() ? 'hydrated' : 'not yet';
}

describe('usePageHydrated', () => {
  it('is false on the server, so the server HTML never depends on it', () => {
    markPageHydrated();
    expect(renderToString(createElement(Probe))).toBe('not yet');
  });

  it('turns true when the page marks itself hydrated, and stays true', () => {
    const { result } = renderHook(() => usePageHydrated());
    expect(result.current).toBe(false);

    act(() => markPageHydrated());
    expect(result.current).toBe(true);

    act(() => markPageHydrated());
    expect(result.current).toBe(true);
  });

  it('is already true for screens that mount after the first page hydrated', () => {
    markPageHydrated();
    const { result } = renderHook(() => usePageHydrated());
    expect(result.current).toBe(true);
  });
});
