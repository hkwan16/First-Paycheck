'use client';

import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { CLOSED, flowPopoverReducer } from './popover';

/** How long a popover waits after the pointer leaves, so it can cross into the popover. */
export const GRACE_MS = 80;

/** Pointer downs inside an element with this attribute are not "outside". */
export const KEEP_ATTRIBUTE = 'data-flow-keep';

export interface UseFlowPopoverOptions {
  /** Move focus to a node's button (after Escape, or a close that took focus with it). */
  focusNode: (id: string) => void;
}

/** Hover (mouse only), not touch or pen: those pin with a press instead. */
const isMouse = (event: PointerEvent) => !event.pointerType || event.pointerType === 'mouse';

const within = (container: EventTarget | null, target: EventTarget | null) =>
  container instanceof Node && target instanceof Node && container.contains(target);

/**
 * The Sankey's popover state with its timing and focus rules: hover opens
 * (and closes 80 ms after the pointer leaves, unless it reaches the popover),
 * focus opens, a press pins, Escape and a pointer down outside close, and
 * focus returns to the node when the popover takes it away.
 */
export function useFlowPopover({ focusNode }: UseFlowPopoverOptions) {
  const [state, dispatch] = useReducer(flowPopoverReducer, CLOSED);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popoverEl = useRef<HTMLElement | null>(null);

  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const leaveLater = useCallback(
    (id: string | null) => {
      cancel();
      timer.current = setTimeout(() => {
        timer.current = null;
        dispatch({ type: 'leave', id });
      }, GRACE_MS);
    },
    [cancel],
  );

  useEffect(() => cancel, [cancel]);

  // A pointer down anywhere but a node, a band or the popover closes it.
  const isOpen = state.open !== null;
  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(`[${KEEP_ATTRIBUTE}]`)) return;
      if (within(popoverEl.current, target)) return;
      cancel();
      dispatch({
        type: 'outside',
        restoreFocus: within(popoverEl.current, document.activeElement),
      });
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [isOpen, cancel]);

  // Focus back on the node once its popover has gone.
  useEffect(() => {
    if (state.restore === null) return;
    focusNode(state.restore);
    dispatch({ type: 'restored' });
  }, [state.restore, focusNode]);

  const onEscape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || state.open === null) return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
    dispatch({ type: 'escape' });
  };

  /** Handlers for a node's button (and, minus focus, for its band). */
  const nodeProps = (id: string) => ({
    onPointerEnter: (event: PointerEvent) => {
      if (!isMouse(event)) return;
      cancel();
      dispatch({ type: 'hover', id });
    },
    onPointerLeave: (event: PointerEvent) => {
      if (isMouse(event)) leaveLater(id);
    },
    onPointerDown: () => {
      cancel();
      dispatch({ type: 'press', id });
    },
    onFocus: () => {
      cancel();
      dispatch({ type: 'focus', id });
    },
    onBlur: (event: FocusEvent) => {
      if (within(popoverEl.current, event.relatedTarget)) return;
      dispatch({ type: 'blur', id });
    },
    onKeyDown: onEscape,
  });

  /** Handlers for a band: hover and press act on the node it flows into. */
  const bandProps = (to: string) => {
    const { onPointerEnter, onPointerLeave, onPointerDown } = nodeProps(to);
    return { onPointerEnter, onPointerLeave, onPointerDown };
  };

  const popoverProps = {
    ref: (el: HTMLElement | null) => {
      popoverEl.current = el;
    },
    onPointerEnter: cancel,
    onPointerLeave: (event: PointerEvent) => {
      if (isMouse(event)) leaveLater(null);
    },
    onBlur: (event: FocusEvent) => {
      const open = state.open;
      if (open === null || within(popoverEl.current, event.relatedTarget)) return;
      // Back to its own node is still "inside".
      if (
        event.relatedTarget instanceof Element &&
        event.relatedTarget.closest(`[${KEEP_ATTRIBUTE}]`)
      ) {
        return;
      }
      dispatch({ type: 'blur', id: open });
    },
    onKeyDown: onEscape,
  };

  return {
    open: state.open,
    pinned: state.pinned,
    nodeProps,
    bandProps,
    popoverProps,
  };
}
