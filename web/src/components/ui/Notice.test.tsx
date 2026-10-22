import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
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

  it('starts its text with the body when there is no title', () => {
    // A stray leading space made the status read " Linked First Platypus
    // Bank." and broke text matches anchored at the start.
    render(
      <Notice tone="confirmed" role="status" icon={null}>
        Linked First Platypus Bank.
      </Notice>,
    );
    expect(screen.getByRole('status').textContent).toBe('Linked First Platypus Bank.');
  });

  it('separates the title from the body with one space', () => {
    render(
      <Notice title="Saved." icon={null} role="status">
        It is a rule now.
      </Notice>,
    );
    expect(screen.getByRole('status').textContent).toBe('Saved. It is a rule now.');
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

  it('forwards a ref, so a screen can move focus to a notice that replaced a control', () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <Notice ref={ref} tabIndex={-1} role="status">
        Unlinked.
      </Notice>,
    );
    ref.current?.focus();
    expect(screen.getByRole('status')).toHaveFocus();
  });
});
