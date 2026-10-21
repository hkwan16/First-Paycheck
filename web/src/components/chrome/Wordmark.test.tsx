import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Wordmark } from './Wordmark';

describe('Wordmark', () => {
  it('links home with the brand mark and name', () => {
    render(<Wordmark />);
    const link = screen.getByRole('link', { name: 'First Paycheck home' });
    expect(link).toHaveAttribute('href', '/');
    expect(link).toHaveTextContent('First Paycheck');
    expect(link.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(link).toHaveClass(
      'font-semibold',
      'text-ink',
      'no-underline',
      'whitespace-nowrap',
      'flex-none',
    );
  });
});
