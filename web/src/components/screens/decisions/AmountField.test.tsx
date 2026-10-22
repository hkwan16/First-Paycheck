import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@/test/render';
import { AmountField } from './AmountField';

describe('AmountField', () => {
  it('is a labeled text input described by its hint', () => {
    const onChange = vi.fn();
    render(
      <AmountField
        id="essentials"
        label="Essential spending per month"
        value="1,823.25"
        onChange={onChange}
        error={null}
        hint="From your spending."
      />,
    );
    const input = screen.getByLabelText('Essential spending per month');
    expect(input).toHaveAttribute('inputmode', 'decimal');
    expect(input).toHaveValue('1,823.25');
    expect(input).toHaveAccessibleDescription('From your spending.');
    expect(input).not.toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(input, { target: { value: '2,000' } });
    expect(onChange).toHaveBeenCalledWith('2,000');
  });

  it('is described by what to fix instead of its hint when it does not read', () => {
    render(
      <AmountField
        id="essentials"
        label="Essential spending per month"
        value="lots"
        onChange={() => undefined}
        error="Enter an amount above $0, like 1,823.25."
        hint="From your spending."
      />,
    );
    const input = screen.getByLabelText('Essential spending per month');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Enter an amount above $0, like 1,823.25.');
    expect(screen.queryByText('From your spending.')).toBeNull();
  });
});
