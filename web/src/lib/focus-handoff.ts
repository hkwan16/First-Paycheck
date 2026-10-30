import { useCallback, useLayoutEffect, useRef } from 'react';

/*
 * Where focus goes when a control removes itself (web/CLAUDE.md, Accessibility).
 * A pressed button that unmounts, or turns disabled, leaves focus on <body>,
 * and a keyboard or screen reader user loses their place. The rule the
 * decision cards follow (issue 167):
 *
 * - Opening an editor in place of the button that opens it focuses the
 *   editor's first field.
 * - Closing an editor (save, cancel, or a choice that replaces it) returns
 *   focus to the control that opens it again; an editor nobody opened (the
 *   first time details are asked for) hands focus to the first control of
 *   what replaces it.
 * - A swap of one control for its counterpart (Mark reached, Not reached yet)
 *   focuses the counterpart; a removed row focuses the row that takes its place.
 * - An action that fills in fields focuses the field it filled.
 *
 * `useFocusHandoff` is the one mechanism: `moveTo(key)` in the handler (or the
 * mutation's onSuccess), `ref={target(key)}` on the element that should get
 * focus. The target is focused once, as soon as it is on the page and can take
 * focus: at once if it already is, when it mounts, or after a later commit
 * that enables it. A container focuses its first control a person can Tab to.
 */

const TABBABLE = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled):not([type="hidden"])',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]',
]
  .map((selector) => `${selector}:not([tabindex="-1"])`)
  .join(', ');

/** The element itself when a person can Tab to it, else its first such descendant. */
function focusable(element: HTMLElement): HTMLElement | null {
  if (!element.isConnected) return null;
  if (element.matches(TABBABLE)) return element;
  return element.querySelector<HTMLElement>(TABBABLE);
}

export interface FocusHandoff<K extends string> {
  /** A ref for the element `key` names. Stable for each key. */
  target: (key: K) => (element: HTMLElement | null) => void;
  /** Focus `key`'s element once it is on the page and can take focus. */
  moveTo: (key: K) => void;
}

export function useFocusHandoff<K extends string>(): FocusHandoff<K> {
  const pending = useRef<K | null>(null);
  const elements = useRef(new Map<K, HTMLElement>());
  const refs = useRef(new Map<K, (element: HTMLElement | null) => void>());

  /** Focus the pending target if it can take focus now. */
  const attempt = useCallback(() => {
    const key = pending.current;
    if (key === null) return;
    const element = elements.current.get(key);
    const into = element ? focusable(element) : null;
    if (!into) return;
    pending.current = null;
    into.focus();
  }, []);

  const target = useCallback(
    (key: K) => {
      let ref = refs.current.get(key);
      if (!ref) {
        // A detached element stays in the map until another takes its key:
        // `focusable` skips it, and the next element with the key may mount
        // before the old one detaches.
        ref = (element: HTMLElement | null) => {
          if (!element) return;
          elements.current.set(key, element);
          attempt();
        };
        refs.current.set(key, ref);
      }
      return ref;
    },
    [attempt],
  );

  const moveTo = useCallback(
    (key: K) => {
      pending.current = key;
      attempt();
    },
    [attempt],
  );

  // A target that was on the page but disabled (or empty) gets focus after the
  // commit that makes it focusable.
  useLayoutEffect(attempt);

  return { target, moveTo };
}
