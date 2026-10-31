import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { cancelOnEscape } from './escape-cancel';

/** An inline editor with a plain field and a control that handles Escape itself. */
function Editor({ onCancel }: { onCancel?: () => void }) {
  return (
    <form aria-label="Editor" onKeyDown={cancelOnEscape(onCancel)}>
      <input aria-label="Name" />
      <input
        aria-label="Search"
        onKeyDown={(event) => {
          // Like a combobox closing its own list.
          if (event.key === 'Escape') event.preventDefault();
        }}
      />
      <button type="button">Other</button>
    </form>
  );
}

describe('cancelOnEscape', () => {
  it('cancels once on Escape from any control in the editor', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<Editor onCancel={onCancel} />);
    await user.type(screen.getByLabelText('Name'), 'x{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Other' }));
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('marks the key handled, so nothing around the editor acts on it too', () => {
    render(<Editor onCancel={() => {}} />);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    screen.getByLabelText('Name').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('ignores every other key', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<Editor onCancel={onCancel} />);
    await user.type(screen.getByLabelText('Name'), 'abc{Enter}{Tab}');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('leaves Escape to a control that handled it first', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<Editor onCancel={onCancel} />);
    await user.type(screen.getByLabelText('Search'), 'x{Escape}');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('leaves Escape to an input method that is composing text', () => {
    const onCancel = vi.fn();
    render(<Editor onCancel={onCancel} />);
    fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Escape', isComposing: true });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('gives no handler to an editor with nothing to go back to', () => {
    expect(cancelOnEscape(undefined)).toBeUndefined();
  });
});
