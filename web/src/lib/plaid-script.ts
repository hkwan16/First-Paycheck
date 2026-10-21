import { useEffect, useState } from 'react';

/**
 * Plaid Link's script, loaded once per page.
 *
 * react-plaid-link loads it from an effect and removes the tag again when the
 * effect is cleaned up while the script is still loading. Strict Mode runs
 * effects twice in development, so the browser ran the script twice and Plaid
 * warned that it was "embedded more than once". Loading it here first, from a
 * single promise, means react-plaid-link finds the tag already on the page
 * (it checks for an existing one) and never adds its own.
 */

/** The URL react-plaid-link looks for; it must match theirs exactly. */
export const PLAID_LINK_SCRIPT = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

let loading: Promise<void> | null = null;

/** Add the script to the page (once) and settle when it has run or failed. */
export function loadPlaidScript(): Promise<void> {
  if (loading) return loading;
  if (window.Plaid) return (loading = Promise.resolve());

  const script = document.createElement('script');
  script.src = PLAID_LINK_SCRIPT;
  script.async = true;
  loading = new Promise<void>((resolve, reject) => {
    script.addEventListener('load', () => resolve());
    script.addEventListener('error', () => {
      // A later call (a remount, a new visit to the screen) tries again.
      script.remove();
      loading = null;
      reject(new Error('Could not load Plaid Link'));
    });
  });
  document.head.appendChild(script);
  return loading;
}

export type PlaidScriptState = 'loading' | 'ready' | 'failed';

/** Start loading Plaid Link's script on mount and follow it. */
export function usePlaidScript(): PlaidScriptState {
  const [state, setState] = useState<PlaidScriptState>('loading');
  useEffect(() => {
    let current = true;
    loadPlaidScript().then(
      () => current && setState('ready'),
      () => current && setState('failed'),
    );
    return () => {
      current = false;
    };
  }, []);
  return state;
}
