import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Input } from './Input';

describe('Input', () => {
  it('is a 44px field with the control radius and a blue focus outline', () => {
    render(<Input aria-label="Email" />);
    expect(screen.getByRole('textbox')).toHaveClass(
      'min-h-11',
      'rounded-control',
      'border-border',
      'text-body',
      'focus:outline-blue',
    );
  });

  it('has a 40px small size for dense tables', () => {
    render(<Input aria-label="x" size="sm" />);
    expect(screen.getByRole('textbox')).toHaveClass('min-h-10', 'text-control');
  });

  it('marks itself invalid', () => {
    render(<Input aria-label="x" invalid />);
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
  });

  it('types', async () => {
    const onChange = vi.fn();
    render(<Input aria-label="x" onChange={onChange} />);
    await userEvent.type(screen.getByRole('textbox'), 'ab');
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
