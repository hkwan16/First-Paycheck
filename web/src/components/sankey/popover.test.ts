import { describe, expect, it } from 'vitest';
import { CLOSED, flowPopoverReducer, type FlowPopoverState } from './popover';

const reduce = (state: FlowPopoverState, ...actions: Parameters<typeof flowPopoverReducer>[1][]) =>
  actions.reduce(flowPopoverReducer, state);

const openOn = (id: string, pinned = false): FlowPopoverState => ({
  open: id,
  pinned,
  restore: null,
});

describe('flowPopoverReducer', () => {
  it('starts closed', () => {
    expect(CLOSED).toEqual({ open: null, pinned: false, restore: null });
  });

  it('opens on hover and follows the pointer to another node', () => {
    expect(reduce(CLOSED, { type: 'hover', id: 'gross' })).toEqual(openOn('gross'));
    expect(reduce(openOn('gross'), { type: 'hover', id: 'take-home' })).toEqual(
      openOn('take-home'),
    );
  });

  it('closes when the grace period after leaving runs out, for the node that is open', () => {
    expect(reduce(openOn('gross'), { type: 'leave', id: 'gross' })).toEqual(CLOSED);
    // A late timer for a node the pointer already left does not close the new one.
    expect(reduce(openOn('take-home'), { type: 'leave', id: 'gross' })).toEqual(
      openOn('take-home'),
    );
    // Leaving the popover itself closes whatever is open.
    expect(reduce(openOn('take-home'), { type: 'leave', id: null })).toEqual(CLOSED);
  });

  it('pins on pointer down and ignores hover and leave while pinned', () => {
    const pinned = reduce(CLOSED, { type: 'press', id: 'gross' });
    expect(pinned).toEqual(openOn('gross', true));
    expect(reduce(pinned, { type: 'hover', id: 'take-home' })).toEqual(pinned);
    expect(reduce(pinned, { type: 'leave', id: 'gross' })).toEqual(pinned);
    expect(reduce(pinned, { type: 'blur', id: 'gross' })).toEqual(pinned);
  });

  it('unpins and closes on a second press of the pinned node; a press elsewhere moves the pin', () => {
    const pinned = openOn('gross', true);
    expect(reduce(pinned, { type: 'press', id: 'gross' })).toEqual(CLOSED);
    expect(reduce(pinned, { type: 'press', id: 'take-home' })).toEqual(openOn('take-home', true));
    // A hover-opened node pins on press instead of closing.
    expect(reduce(openOn('gross'), { type: 'press', id: 'gross' })).toEqual(openOn('gross', true));
  });

  it('opens on focus, keeping a pin that the same press just made', () => {
    expect(reduce(CLOSED, { type: 'focus', id: 'gross' })).toEqual(openOn('gross'));
    // Pointer down pins, then the click focuses the same button.
    expect(reduce(CLOSED, { type: 'press', id: 'gross' }, { type: 'focus', id: 'gross' })).toEqual(
      openOn('gross', true),
    );
    // Moving focus elsewhere (arrow keys, Tab) opens that node unpinned.
    expect(reduce(openOn('gross', true), { type: 'focus', id: 'take-home' })).toEqual(
      openOn('take-home'),
    );
  });

  it('closes on blur of the open node only', () => {
    expect(reduce(openOn('gross'), { type: 'blur', id: 'gross' })).toEqual(CLOSED);
    expect(reduce(openOn('take-home'), { type: 'blur', id: 'gross' })).toEqual(openOn('take-home'));
  });

  it('closes on Escape, pinned or not, and asks for focus back on the node', () => {
    expect(reduce(openOn('gross', true), { type: 'escape' })).toEqual({
      open: null,
      pinned: false,
      restore: 'gross',
    });
    expect(reduce(CLOSED, { type: 'escape' })).toEqual(CLOSED);
  });

  it('closes on a pointer down outside, restoring focus only when it was in the popover', () => {
    expect(reduce(openOn('gross', true), { type: 'outside', restoreFocus: false })).toEqual(CLOSED);
    expect(reduce(openOn('gross', true), { type: 'outside', restoreFocus: true })).toEqual({
      open: null,
      pinned: false,
      restore: 'gross',
    });
  });

  it('clears the focus request once focus is back', () => {
    const escaped = reduce(openOn('gross'), { type: 'escape' });
    expect(reduce(escaped, { type: 'restored' })).toEqual(CLOSED);
  });

  it('does not reopen when the focus it gave back lands on the node', () => {
    const escaped = reduce(openOn('gross', true), { type: 'escape' });
    expect(reduce(escaped, { type: 'focus', id: 'gross' })).toEqual(CLOSED);
  });
});
