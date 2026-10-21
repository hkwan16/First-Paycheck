import { act, render, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as PlaidScript from './plaid-script';

let mod: typeof PlaidScript;

const scripts = () =>
  Array.from(document.querySelectorAll<HTMLScriptElement>('script')).filter(
    (s) => s.src === 'https://cdn.plaid.com/link/v2/stable/link-initialize.js',
  );

beforeEach(async () => {
  // The loader keeps one promise per page: a fresh module is a fresh page.
  vi.resetModules();
  mod = await import('./plaid-script');
});
afterEach(() => {
  for (const s of scripts()) s.remove();
  vi.unstubAllGlobals();
});

describe('loadPlaidScript', () => {
  it('adds the Plaid Link script once, however many times it is asked', async () => {
    const first = mod.loadPlaidScript();
    const second = mod.loadPlaidScript();
    expect(second).toBe(first);
    expect(scripts()).toHaveLength(1);
    expect(scripts()[0]?.async).toBe(true);
    scripts()[0]?.dispatchEvent(new Event('load'));
    await expect(first).resolves.toBeUndefined();
  });

  it('is already done when Plaid is on the page', async () => {
    vi.stubGlobal('Plaid', { create: vi.fn() });
    await expect(mod.loadPlaidScript()).resolves.toBeUndefined();
    expect(scripts()).toHaveLength(0);
  });

  it('fails when the script cannot load, and tries again with a new tag next time', async () => {
    const failed = mod.loadPlaidScript();
    scripts()[0]?.dispatchEvent(new Event('error'));
    await expect(failed).rejects.toThrow('Could not load Plaid Link');
    expect(scripts()).toHaveLength(0);

    const retry = mod.loadPlaidScript();
    expect(retry).not.toBe(failed);
    expect(scripts()).toHaveLength(1);
    retry.catch(() => undefined);
  });
});

describe('usePlaidScript', () => {
  it('is loading, then ready once the script has run', async () => {
    const { result } = renderHook(() => mod.usePlaidScript());
    expect(result.current).toBe('loading');
    await act(async () => scripts()[0]?.dispatchEvent(new Event('load')));
    expect(result.current).toBe('ready');
  });

  it('reports a script that could not load', async () => {
    const { result } = renderHook(() => mod.usePlaidScript());
    await act(async () => scripts()[0]?.dispatchEvent(new Event('error')));
    expect(result.current).toBe('failed');
  });

  it('adds one tag under Strict Mode, which runs effects twice in development', () => {
    function Probe() {
      mod.usePlaidScript();
      return null;
    }
    render(
      <StrictMode>
        <Probe />
        <Probe />
      </StrictMode>,
    );
    expect(scripts()).toHaveLength(1);
  });
});
