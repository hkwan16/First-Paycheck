import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';

describe('Button', () => {
  it('renders a type="button" in the default variant at 44px', () => {
    render(<Button>Back</Button>);
    const button = screen.getByRole('button', { name: 'Back' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveClass('bg-fill', 'text-ink', 'min-h-11', 'rounded-control');
  });

  it('renders the primary variant in blue', () => {
    render(<Button variant="primary">Continue</Button>);
    expect(screen.getByRole('button')).toHaveClass('bg-blue', 'text-white');
  });

  it('renders the small size at 36px', () => {
    render(<Button size="sm">Replace</Button>);
    expect(screen.getByRole('button')).toHaveClass('min-h-9', 'text-small');
  });

  it('gives press feedback that reduced motion turns off', () => {
    render(<Button>Press</Button>);
    expect(screen.getByRole('button')).toHaveClass(
      'active:scale-[.97]',
      'motion-reduce:active:scale-100',
      // Tailwind v4 scale-* sets the standalone `scale` property, not `transform`.
      'transition-[scale,background-color]',
    );
  });

  it('exposes the confirmed variant as a pressed toggle', () => {
    render(
      <Button variant="confirmed" pressed>
        Confirmed
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Confirmed', pressed: true });
    expect(button).toHaveClass('bg-green-tint', 'text-green-text');
  });

  it('requires pressed for the confirmed variant', () => {
    // @ts-expect-error `pressed` is required when variant is "confirmed".
    render(<Button variant="confirmed">Confirmed</Button>);
  });

  it('reports an unpressed toggle on the default variant', () => {
    render(<Button pressed={false}>Confirm</Button>);
    expect(screen.getByRole('button', { pressed: false })).toBeInTheDocument();
  });

  it('calls onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('renders a Next link when given href', () => {
    render(
      <Button href="/sign-in" variant="primary">
        See your plan
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'See your plan' });
    expect(link).toHaveAttribute('href', '/sign-in');
    expect(link).toHaveClass('bg-blue', 'no-underline');
  });

  it('keeps its label and width while loading, and ignores clicks', async () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" loading onClick={onClick}>
        Save this decision
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Save this decision' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveClass('bg-blue');
    expect(screen.getByText('Save this decision')).toHaveClass('opacity-0');
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('disables natively and greys out', () => {
    render(
      <Button variant="primary" disabled>
        Confirm and continue
      </Button>,
    );
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    expect(button).toHaveClass('disabled:bg-fill', 'disabled:text-ink-3');
  });

  it('stretches to the container with block', () => {
    render(<Button block>Sign in</Button>);
    expect(screen.getByRole('button')).toHaveClass('w-full');
  });
});
