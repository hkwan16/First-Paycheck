import { useSyncExternalStore } from 'react';

/*
 * Whether the browser could read the Supabase session the last time a
 * request needed it (issue 225). The session tokens report each read
 * (`createSessionTokens({ onSessionReadable })`), and `SessionProblemNotice`
 * shows a way out while a read has timed out.
 */

let readable = true;
const listeners = new Set<() => void>();

export const sessionStatus = {
  readable: () => readable,
  report(next: boolean) {
    if (next === readable) return;
    readable = next;
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** True while the last session read timed out; the server render always reads true. */
export function useSessionReadable(): boolean {
  return useSyncExternalStore(sessionStatus.subscribe, sessionStatus.readable, () => true);
}
