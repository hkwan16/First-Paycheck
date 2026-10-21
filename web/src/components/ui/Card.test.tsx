import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Card } from './Card';

describe('Card', () => {
  it('renders a white section with the card radius, shadow, 20px padding and 16px gap', () => {
    render(<Card aria-label="Bank accounts">x</Card>);
    const card = screen.getByRole('region', { name: 'Bank accounts' });
    expect(card.tagName).toBe('SECTION');
    expect(card).toHaveClass(
      'bg-surface',
      'rounded-card',
      'shadow-card',
      'p-5',
      'gap-4',
      'flex',
      'flex-col',
    );
  });

  it('renders as another element', () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <Card as="form" aria-label="Sign in" padding={24} onSubmit={onSubmit} noValidate>
        <button type="submit">Go</button>
      </Card>,
    );
    const form = screen.getByRole('form', { name: 'Sign in' });
    expect(form).toHaveClass('p-6');
    expect(form).toHaveAttribute('novalidate');
    screen.getByRole('button').click();
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it.each([
    [0, 'gap-0'],
    [12, 'gap-3'],
    [14, 'gap-3.5'],
    [24, 'gap-6'],
  ] as const)('spaces children with gap %i', (gap, cls) => {
    render(
      <Card as="div" gap={gap}>
        x
      </Card>,
    );
    expect(screen.getByText('x')).toHaveClass(cls);
  });

  it.each([
    ['confirmed', 'bg-green-tint'],
    ['warning', 'bg-amber-tint'],
  ] as const)('tints the whole card for a %s state', (tint, cls) => {
    render(
      <Card as="div" tint={tint}>
        x
      </Card>,
    );
    expect(screen.getByText('x')).toHaveClass(cls);
    expect(screen.getByText('x')).not.toHaveClass('bg-surface');
  });

  it('insets a fallback card with a border on the well color', () => {
    render(
      <Card as="div" inset>
        x
      </Card>,
    );
    expect(screen.getByText('x')).toHaveClass('bg-well', 'border', 'border-ink/14');
  });
});
