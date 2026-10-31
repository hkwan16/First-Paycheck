import type { KeyboardEvent, KeyboardEventHandler } from 'react';

/*
 * Escape closes an inline editor the way its Cancel button does (issue 184).
 * Put the handler on the editor's container (its <form>), so Escape works
 * from every control in it, and pass the same function Cancel calls, so
 * focus goes back to what opened the editor (`useFocusHandoff`). An editor
 * with no Cancel (nothing to go back to) gets no handler.
 *
 * A control that uses Escape itself (a list it closes) calls
 * `preventDefault()` and keeps it; so does an input method still composing
 * text. Escape that cancels is marked handled, so nothing around the editor
 * acts on it again.
 */
export function cancelOnEscape(cancel: () => void): KeyboardEventHandler;
export function cancelOnEscape(cancel: (() => void) | undefined): KeyboardEventHandler | undefined;
export function cancelOnEscape(cancel: (() => void) | undefined): KeyboardEventHandler | undefined {
  if (!cancel) return undefined;
  return (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
    event.preventDefault();
    cancel();
  };
}
