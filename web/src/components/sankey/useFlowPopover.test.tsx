import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, userEvent } from '@/test/render';
import { GRACE_MS, useFlowPopover } from './useFlowPopover';

/** Two nodes and a popover with a link, wired the way the Sankey wires them. */
function Harness() {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const popover = useFlowPopover({ focusNode: (id) => buttons.current.get(id)?.focus() });
  return (
    <div>
      <button type="button">Elsewhere</button>
      <div data-flow-keep="">
        {['gross', 'take-home'].map((id) => (
          <button
            key={id}
            type="button"
            ref={(el) => {
              if (el) buttons.current.set(id, el);
            }}
            {...popover.nodeProps(id)}
          >
            {id}
          </button>
        ))}
      </div>
      {popover.open && (
        <div role="group" aria-label={`About ${popover.open}`} {...popover.popoverProps}>
          {popover.pinned ? 'pinned' : 'open'} <a href="#later">More</a>
        </div>
      )}
    </div>
  );
}

const group = () => screen.queryByRole('group');

describe('useFlowPopover grace period', () => {
  // Synchronous events and a clock only the test moves, to the millisecond.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens on hover and closes 80 ms after the pointer leaves', () => {
    render(<Harness />);
    const gross = screen.getByRole('button', { name: 'gross' });
    fireEvent.pointerOver(gross, { pointerType: 'mouse' });
    expect(group()).toHaveAccessibleName('About gross');

    fireEvent.pointerOut(gross, { pointerType: 'mouse' });
    expect(GRACE_MS).toBe(80);
    act(() => vi.advanceTimersByTime(GRACE_MS - 1));
    expect(group()).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(group()).not.toBeInTheDocument();
  });

  it('opens nothing on a touch hover: touch pins with a press instead', () => {
    render(<Harness />);
    fireEvent.pointerOver(screen.getByRole('button', { name: 'gross' }), { pointerType: 'touch' });
    expect(group()).not.toBeInTheDocument();
  });
});

describe('useFlowPopover', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Harness />);
    return user;
  };

  it('stays open while the pointer crosses into the popover within the grace period', async () => {
    const user = setup();
    await user.hover(screen.getByRole('button', { name: 'gross' }));
    await user.unhover(screen.getByRole('button', { name: 'gross' }));
    await user.hover(group()!);
    act(() => vi.advanceTimersByTime(500));
    expect(group()).toHaveAccessibleName('About gross');

    await user.unhover(group()!);
    act(() => vi.advanceTimersByTime(GRACE_MS));
    expect(group()).not.toBeInTheDocument();
  });

  it('pins on press, so leaving does not close it, and a second press unpins', async () => {
    const user = setup();
    const gross = screen.getByRole('button', { name: 'gross' });
    await user.click(gross);
    expect(group()).toHaveTextContent('pinned');
    await user.unhover(gross);
    act(() => vi.advanceTimersByTime(500));
    expect(group()).toHaveTextContent('pinned');

    await user.pointer({ keys: '[MouseLeft]', target: gross });
    expect(group()).not.toBeInTheDocument();
  });

  it('opens on keyboard focus and follows focus to the next node', async () => {
    const user = setup();
    await user.tab();
    await user.tab();
    expect(screen.getByRole('button', { name: 'gross' })).toHaveFocus();
    expect(group()).toHaveAccessibleName('About gross');
    await user.tab();
    expect(group()).toHaveAccessibleName('About take-home');
  });

  it('keeps the popover open while focus moves into it, and closes when focus leaves both', async () => {
    const user = setup();
    screen.getByRole('button', { name: 'take-home' }).focus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'More' })).toHaveFocus();
    expect(group()).toHaveAccessibleName('About take-home');

    act(() => screen.getByRole('button', { name: 'Elsewhere' }).focus());
    expect(group()).not.toBeInTheDocument();
  });

  it('closes on Escape, even pinned, and puts focus back on the node', async () => {
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'take-home' }));
    await user.tab();
    expect(screen.getByRole('link', { name: 'More' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(group()).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'take-home' })).toHaveFocus();
  });

  it('closes a pinned popover on a pointer down outside without taking focus', async () => {
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'gross' }));
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(group()).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus();
  });

  it('a pointer down inside the popover keeps it open', async () => {
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'gross' }));
    await user.pointer({ keys: '[MouseLeft]', target: group()! });
    expect(group()).toHaveTextContent('pinned');
  });
});
