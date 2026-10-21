import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Badge } from './Badge';

describe('Badge', () => {
  it('defaults to a neutral pill', () => {
    render(<Badge>Not saved</Badge>);
    expect(screen.getByText('Not saved')).toHaveClass(
      'rounded-full',
      'text-tiny',
      'font-semibold',
      'bg-fill',
      'text-ink-2',
    );
  });

  it.each([
    ['confirmed', 'bg-green-tint', 'text-green-text'],
    ['warning', 'bg-amber-tint', 'text-amber-text'],
    ['off', 'bg-red-tint', 'text-red-text'],
    ['blue', 'bg-blue-tint', 'text-blue-text'],
    ['coral', 'bg-coral-tint', 'text-coral-text'],
    ['teal', 'bg-teal-tint', 'text-teal-text'],
    ['plum', 'bg-plum-tint', 'text-plum-text'],
  ] as const)('uses the %s tint with its text pair', (tone, bg, text) => {
    render(<Badge tone={tone}>Label</Badge>);
    expect(screen.getByText('Label')).toHaveClass(bg, text);
  });

  it('fills solid with white text', () => {
    render(
      <Badge tone="confirmed" solid>
        Verified against calculator
      </Badge>,
    );
    expect(screen.getByText('Verified against calculator')).toHaveClass('bg-green', 'text-white');
  });

  it('puts an icon before the label', () => {
    render(
      <Badge tone="confirmed" icon={<svg data-testid="icon" />}>
        2 linked
      </Badge>,
    );
    const badge = screen.getByText('2 linked');
    expect(badge.firstElementChild).toBe(screen.getByTestId('icon'));
  });

  it('becomes a link with href', () => {
    render(
      <Badge tone="plum" href="/sign-in">
        401(k)
      </Badge>,
    );
    const link = screen.getByRole('link', { name: '401(k)' });
    expect(link).toHaveAttribute('href', '/sign-in');
    expect(link).toHaveClass('bg-plum-tint', 'no-underline');
  });
});
