import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { server } from '@/test/msw/server';
import { SampleScreen } from './SampleScreen';

/* The plan sample screens (/dev/screens/plan and /dev/screens/plan/empty). */

function countRequests() {
  const seen: string[] = [];
  server.events.on('request:start', ({ request }) => {
    seen.push(`${request.method} ${new URL(request.url).pathname}`);
  });
  return seen;
}

afterEach(() => server.events.removeAllListeners());

describe('SampleScreen plan screens', () => {
  it('renders the whole sample plan, with no requests', () => {
    const requests = countRequests();
    render(<SampleScreen screen="plan" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Your plan, on one page' })).toBeVisible();
    expect(screen.getByText('4 of 4 decisions saved')).toBeInTheDocument();
    const decisions = screen.getByRole('list', { name: 'Saved decisions' });
    expect(within(decisions).getAllByRole('heading', { level: 2 })).toHaveLength(4);
    expect(screen.getByRole('button', { name: 'Download PDF' })).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Plan and calendar' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(requests).toEqual([]);
  });

  it('renders the plan of someone who has saved nothing, with no requests', () => {
    const requests = countRequests();
    render(<SampleScreen screen="plan-empty" />);
    expect(screen.getByText('No decisions saved yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to decisions' })).toBeInTheDocument();
    expect(requests).toEqual([]);
  });
});
