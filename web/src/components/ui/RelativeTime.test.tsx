import { act, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelativeTime } from './RelativeTime';

const SYNCED = '2026-10-17T15:56:00Z';

describe('RelativeTime', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-10-17T16:00:00Z') }));
  afterEach(() => vi.useRealTimers());

  it('reads a timestamp relative to now, in a <time> element', () => {
    render(<RelativeTime value={SYNCED} />);
    const time = screen.getByText('4 minutes ago');
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('dateTime', SYNCED);
  });

  it('keeps itself current while the page stays open', () => {
    render(<RelativeTime value={SYNCED} />);
    act(() => vi.advanceTimersByTime(3 * 60_000));
    expect(screen.getByText('7 minutes ago')).toBeInTheDocument();
  });

  it('renders the plain date on the server, so hydration never depends on the clock', () => {
    const html = renderToString(<RelativeTime value={SYNCED} />);
    expect(html).toContain('Oct 17, 2026');
    expect(html).not.toContain('ago');
  });
});
