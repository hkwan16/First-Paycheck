import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { render, screen, userEvent, within } from '@/test/render';
import { CardErrorBoundary } from './CardErrorBoundary';

/** Throws while `state.broken` is set, so a test can mend it before Try again. */
const state = { broken: true };
function Fragile() {
  if (state.broken) throw new Error('The card read a field that was not there');
  return <p>Mended card</p>;
}

function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount((n) => n + 1)}>
      Clicked {count} times
    </button>
  );
}

let consoleError: MockInstance<typeof console.error>;
beforeEach(() => {
  state.broken = true;
  // React reports the caught error too; the test reads only the boundary's own line.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

const ownLogs = () =>
  consoleError.mock.calls.filter(([first]) => String(first).startsWith('[CardErrorBoundary]'));

describe('CardErrorBoundary', () => {
  it('renders its children while nothing throws', () => {
    render(
      <CardErrorBoundary title="Recurring charges">
        <p>Netflix</p>
      </CardErrorBoundary>,
    );
    expect(screen.getByText('Netflix')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it("shows the card's frame with a calm notice when a child throws, and logs it once", () => {
    render(
      <CardErrorBoundary title="Recurring charges">
        <Fragile />
      </CardErrorBoundary>,
    );
    const card = screen.getByRole('region', { name: 'Recurring charges' });
    expect(
      within(card).getByRole('heading', { level: 2, name: 'Recurring charges' }),
    ).toBeVisible();
    expect(within(card).getByRole('status')).toHaveTextContent(
      'This card could not be shown. The rest of the page still works, and nothing you saved has changed.',
    );
    expect(ownLogs()).toHaveLength(1);
    expect(ownLogs()[0]).toEqual([
      '[CardErrorBoundary] Recurring charges failed to render',
      expect.objectContaining({ message: 'The card read a field that was not there' }),
    ]);
  });

  it('keeps the layout class on the fallback, so the page does not shift', () => {
    render(
      <CardErrorBoundary title="Net worth" className="flex-[1_1_320px]">
        <Fragile />
      </CardErrorBoundary>,
    );
    expect(screen.getByRole('region', { name: 'Net worth' })).toHaveClass('flex-[1_1_320px]');
  });

  it('remounts the card on Try again', async () => {
    const user = userEvent.setup();
    render(
      <CardErrorBoundary title="Recurring charges">
        <Fragile />
      </CardErrorBoundary>,
    );
    state.broken = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Mended card')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('shows the notice again when the card still throws after Try again', async () => {
    const user = userEvent.setup();
    render(
      <CardErrorBoundary title="Recurring charges">
        <Fragile />
      </CardErrorBoundary>,
    );
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(ownLogs()).toHaveLength(2);
  });

  it('leaves the other cards on the page working', async () => {
    const user = userEvent.setup();
    render(
      <>
        <CardErrorBoundary title="Recurring charges">
          <Fragile />
        </CardErrorBoundary>
        <CardErrorBoundary title="Transactions">
          <Counter />
        </CardErrorBoundary>
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Clicked 0 times' }));
    expect(screen.getByRole('button', { name: 'Clicked 1 times' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Recurring charges' })).toBeInTheDocument();
  });
});
