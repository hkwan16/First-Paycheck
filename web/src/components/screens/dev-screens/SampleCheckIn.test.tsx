import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { NOVEMBER_ID } from '@/test/fixtures/checkins';
import { server } from '@/test/msw/server';
import { SampleScreen } from './SampleScreen';

/*
 * The check-in sample screens (/dev/screens/check-in*), in their own file so
 * the M8 cases stay apart from the setup screens' in SampleScreen.test.tsx.
 */

function countRequests() {
  const seen: string[] = [];
  server.events.on('request:start', ({ request }) => {
    seen.push(`${request.method} ${new URL(request.url).pathname}`);
  });
  return seen;
}

afterEach(() => server.events.removeAllListeners());

describe('SampleScreen check-in screens', () => {
  it('renders the open November check-in from the sample data, with no requests', async () => {
    const requests = countRequests();
    render(<SampleScreen screen="check-in" />);
    expect(screen.getByRole('heading', { level: 1, name: 'November check-in' })).toBeVisible();
    const findings = screen.getByRole('region', { name: 'What changed' });
    expect(within(findings).getAllByRole('button', { name: 'Done' })).toHaveLength(9);
    expect(within(findings).getByText('0 of 9 handled')).toBeInTheDocument();
    const nav = screen.getByRole('link', { name: 'Monthly check-in' });
    expect(nav).toHaveAttribute('aria-current', 'page');
    expect(nav).toHaveAttribute('href', `/check-in/${NOVEMBER_ID}`);
    const netWorth = screen.getByRole('region', { name: 'Net worth' });
    expect(within(netWorth).getByText('As of Nov 15, 2026')).toBeInTheDocument();
    expect(within(netWorth).getByRole('table', { name: 'Holdings' })).toBeInTheDocument();
    const coming = screen.getByRole('region', { name: 'Coming up' });
    expect(within(coming).getAllByRole('listitem')).toHaveLength(3);
    expect(requests).toEqual([]);
  });

  it('renders the completed November check-in, with no requests', () => {
    const requests = countRequests();
    render(<SampleScreen screen="check-in-complete" />);
    const findings = screen.getByRole('region', { name: 'What changed' });
    expect(within(findings).getByText('9 of 9 handled')).toBeInTheDocument();
    expect(within(findings).getAllByRole('button', { name: 'Undo' })).toHaveLength(9);
    expect(requests).toEqual([]);
  });

  it('renders the list of check-ins, with no requests', () => {
    const requests = countRequests();
    render(<SampleScreen screen="check-in-index" />);
    const list = screen.getByRole('list', { name: 'Check-ins' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Monthly check-in' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(requests).toEqual([]);
  });
});
