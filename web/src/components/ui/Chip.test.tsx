import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Chip } from './Chip';

describe('Chip', () => {
  it('renders a quiet neutral pill', () => {
    render(<Chip>Acme Corp · Semi-monthly</Chip>);
    expect(screen.getByText('Acme Corp · Semi-monthly')).toHaveClass(
      'rounded-full',
      'bg-fill',
      'text-tiny',
      'font-medium',
      'text-ink-2',
      'whitespace-nowrap',
    );
  });

  it('merges a caller class', () => {
    render(<Chip className="ml-2">J. Rivera</Chip>);
    expect(screen.getByText('J. Rivera')).toHaveClass('ml-2', 'bg-fill');
  });
});
