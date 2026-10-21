/*
 * Which Sankey node's popover is open, ported from the mockup's openNode,
 * closeNode and closeAll (docs/mockup/Spending.dc.html). The reducer is pure;
 * `useFlowPopover` adds the grace timer, the outside listener and the focus
 * restore around it.
 */

export interface FlowPopoverState {
  /** The node whose popover is showing. */
  open: string | null;
  /** Opened by a press: hover and blur no longer close it. */
  pinned: boolean;
  /** A node to move focus back to (after Escape, or a close that took focus with it). */
  restore: string | null;
}

export type FlowPopoverAction =
  /** A mouse pointer entered a node or its band. */
  | { type: 'hover'; id: string }
  /** The grace period after the pointer left `id` (or the popover, `null`) ran out. */
  | { type: 'leave'; id: string | null }
  | { type: 'focus'; id: string }
  /** Focus left the node and its popover. */
  | { type: 'blur'; id: string }
  /** Pointer down on a node or band: pin it, or unpin the pinned one. */
  | { type: 'press'; id: string }
  | { type: 'escape' }
  /** Pointer down anywhere else; `restoreFocus` when focus was inside the popover. */
  | { type: 'outside'; restoreFocus: boolean }
  /** Focus is back on the node. */
  | { type: 'restored' };

export const CLOSED: FlowPopoverState = { open: null, pinned: false, restore: null };

const opened = (id: string, pinned: boolean): FlowPopoverState => ({
  open: id,
  pinned,
  restore: null,
});

export function flowPopoverReducer(
  state: FlowPopoverState,
  action: FlowPopoverAction,
): FlowPopoverState {
  switch (action.type) {
    case 'hover':
      return state.pinned ? state : opened(action.id, false);
    case 'leave':
      if (state.pinned || state.open === null) return state;
      return action.id === null || action.id === state.open ? CLOSED : state;
    case 'focus':
      // Focus handed back after a close leaves it closed.
      if (state.restore === action.id) return CLOSED;
      // A press focuses the button it pinned: keep that pin.
      return state.open === action.id ? state : opened(action.id, false);
    case 'blur':
      return !state.pinned && state.open === action.id ? CLOSED : state;
    case 'press':
      return state.pinned && state.open === action.id ? CLOSED : opened(action.id, true);
    case 'escape':
      return state.open === null ? state : { open: null, pinned: false, restore: state.open };
    case 'outside':
      if (state.open === null) return state;
      return { open: null, pinned: false, restore: action.restoreFocus ? state.open : null };
    case 'restored':
      return state.restore === null ? state : { ...state, restore: null };
  }
}
