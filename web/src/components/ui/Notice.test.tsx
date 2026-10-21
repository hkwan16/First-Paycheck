import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Notice } from './Notice';

describe('Notice', () => {
  it('defaults to a blue information panel with a shield icon', () => {
    const { container } = render(<Notice>SSNs are blacked out.</Notice>);
    const notice = container.firstElementChild as HTMLElement;
    expect(notice).toHaveClass('bg-blue-tint', 'text-ink', 'rounded-tile', 'text-small');
    expect(notice.querySelector('svg')).not.toBeNull();
    expect(screen.getByText('SSNs are blacked out.')).toBeInTheDocument();
  });

  it.each([
    ['confirmed', 'bg-green-tint', 'text-green-text'],
    ['warning', 'bg-amber-tint', 'text-amber-text'],
  ] as const)('renders the %s state in its pair', (tone, bg, text) => {
    const { container } = render(<Notice tone={tone}>x</Notice>);
    expect(container.firstElementChild).toHaveClass(bg, text);
  });

  it('bolds a title before the body', () => {
    render(<Notice title="The math checks out.">Gross minus deductions equals net.</Notice>);
    expect(screen.getByText('The math checks out.').tagName).toBe('STRONG');
  });

  it('accepts a custom icon or none', () => {
    const { container, rerender } = render(<Notice icon={<svg data-testid="custom" />}>x</Notice>);
    expect(screen.getByTestId('custom')).toBeInTheDocument();
    rerender(<Notice icon={null}>x</Notice>);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('has a compact size and passes a live-region role through', () => {
    render(
      <Notice tone="confirmed" compact role="status">
        Saved as a rule.
      </Notice>,
    );
    expect(screen.getByRole('status')).toHaveClass('rounded-control', 'py-3');
  });
});
