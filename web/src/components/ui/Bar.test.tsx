import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Bar } from './Bar';

describe('Bar', () => {
  it('is a labeled progressbar from 0 to 100', () => {
    render(<Bar value={62} tone="confirmed" label="Fields confirmed" />);
    const bar = screen.getByRole('progressbar', { name: 'Fields confirmed' });
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(bar).toHaveAttribute('aria-valuenow', '62');
    expect(bar).toHaveClass('h-2', 'rounded-full', 'bg-line', 'overflow-hidden');
  });

  it('fills to the value in the tone color', () => {
    render(<Bar value={25} tone="plum" label="401(k)" />);
    const fill = screen.getByRole('progressbar').firstElementChild as HTMLElement;
    expect(fill.style.width).toBe('25%');
    expect(fill).toHaveClass('bg-plum', 'transition-[width]');
  });

  it.each([
    [-5, 0],
    [140, 100],
    [Number.NaN, 0],
    [33.6, 33.6],
  ])('clamps %s to %s', (value, expected) => {
    render(<Bar value={value} tone="blue" label="x" />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', String(expected));
    expect((bar.firstElementChild as HTMLElement).style.width).toBe(`${expected}%`);
  });

  it('has a thinner 6px track', () => {
    render(<Bar value={50} tone="teal" height={6} label="x" />);
    expect(screen.getByRole('progressbar')).toHaveClass('h-1.5');
  });

  it('can carry a spoken value', () => {
    render(<Bar value={25} tone="off" label="401(k)" valueText="25% of plan" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '25% of plan');
  });
});
