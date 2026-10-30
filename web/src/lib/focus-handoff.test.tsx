import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useFocusHandoff } from './focus-handoff';

/** An editor that replaces the button that opens it, as the decision cards do. */
function Editor() {
  const focus = useFocusHandoff<'open' | 'form'>();
  const [open, setOpen] = useState(false);
  const [later, setLater] = useState(false);
  return open ? (
    <form ref={focus.target('form')} aria-label="Editor">
      <p>Not a control</p>
      <button type="button" tabIndex={-1}>
        Roving, not a stop
      </button>
      <input aria-label="Disabled" disabled />
      <input aria-label="First field" />
      <button
        type="button"
        onClick={() => {
          focus.moveTo('open');
          setOpen(false);
        }}
      >
        Close
      </button>
    </form>
  ) : (
    <>
      <button
        type="button"
        ref={focus.target('open')}
        onClick={() => {
          focus.moveTo('form');
          setOpen(true);
        }}
      >
        Open
      </button>
      <button type="button" onClick={() => setLater(true)}>
        Show more
      </button>
      {later && <button ref={focus.target('form')}>Not asked for</button>}
    </>
  );
}

describe('useFocusHandoff', () => {
  it('focuses a target that mounts with the change, and the first field of a container', async () => {
    const user = userEvent.setup();
    render(<Editor />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByLabelText('First field')).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus();
  });

  it('never moves focus nobody asked for', async () => {
    const user = userEvent.setup();
    render(<Editor />);
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getByRole('button', { name: 'Show more' })).toHaveFocus();
  });

  it('focuses a target already on the page at once, and waits for a disabled one', async () => {
    function Waiting() {
      const focus = useFocusHandoff<'field'>();
      const [disabled, setDisabled] = useState(true);
      return (
        <>
          <input aria-label="Field" ref={focus.target('field')} disabled={disabled} />
          <button type="button" onClick={() => focus.moveTo('field')}>
            Ask
          </button>
          <button type="button" onClick={() => setDisabled(false)}>
            Enable
          </button>
        </>
      );
    }
    const user = userEvent.setup();
    render(<Waiting />);
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    expect(screen.getByRole('button', { name: 'Ask' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Enable' }));
    expect(screen.getByLabelText('Field')).toHaveFocus();
  });
});
