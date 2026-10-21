import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Tile } from './Tile';

describe('Tile', () => {
  it('renders a neutral result panel', () => {
    render(<Tile>result</Tile>);
    expect(screen.getByText('result')).toHaveClass(
      'bg-tile',
      'rounded-tile',
      'p-4',
      'flex',
      'flex-col',
      'gap-2.5',
    );
  });

  it.each([
    ['plum', 'bg-plum-tint/60'],
    ['teal', 'bg-teal-tint/50'],
    ['coral', 'bg-coral-tint/60'],
    ['blue', 'bg-blue-tint/60'],
  ] as const)('washes with the %s hue', (tone, cls) => {
    render(<Tile tone={tone}>result</Tile>);
    expect(screen.getByText('result')).toHaveClass(cls);
  });

  it('renders as a section with a label', () => {
    render(
      <Tile as="section" aria-label="Holdings">
        x
      </Tile>,
    );
    expect(screen.getByRole('region', { name: 'Holdings' })).toBeInTheDocument();
  });
});
