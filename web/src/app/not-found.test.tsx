import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/chrome/HeaderAccount', () => ({
  HeaderAccount: () => <button type="button">alex@example.com</button>,
}));
vi.mock('./hydration-marker', () => ({ HydrationMarker: () => null }));

import NotFound from './not-found';

describe('the app not-found page (issue 237)', () => {
  it('says the page was not found inside the app header, with a way back', () => {
    render(<NotFound />);
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('link', { name: 'First Paycheck home' })).toHaveAttribute(
      'href',
      '/',
    );
    // A signed-in person keeps their account menu.
    expect(within(header).getByRole('button', { name: 'alex@example.com' })).toBeInTheDocument();

    const main = screen.getByRole('main');
    expect(within(main).getByRole('heading', { level: 1 })).toHaveTextContent('Page not found');
    expect(main).toHaveTextContent('There is nothing at this address.');
    expect(within(main).getByRole('link', { name: 'Go to First Paycheck' })).toHaveAttribute(
      'href',
      '/',
    );
  });
});
