import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Select } from './Select';

describe('Select', () => {
  it('is a native select in the field style', async () => {
    const onChange = vi.fn();
    render(
      <Select aria-label="Role" defaultValue="spending" onChange={onChange}>
        <option value="spending">Spending</option>
        <option value="emergency">Emergency fund</option>
      </Select>,
    );
    const select = screen.getByRole('combobox', { name: 'Role' });
    expect(select).toHaveClass('min-h-11', 'rounded-control');
    await userEvent.selectOptions(select, 'emergency');
    expect(onChange).toHaveBeenCalledOnce();
  });

  // The platform's arrow is drawn by the OS theme, which moves it with host settings (macOS
  // light and dark appearance): the same page then renders differently from one hour to the next.
  it('draws its own chevron in the text color, clear of the text, at both sizes', () => {
    render(
      <>
        <Select aria-label="Role" />
        <Select aria-label="Period" size="sm" className="w-auto" />
      </>,
    );
    const md = screen.getByRole('combobox', { name: 'Role' });
    expect(md).toHaveClass('appearance-none', 'select-chevron', 'pr-9');
    const sm = screen.getByRole('combobox', { name: 'Period' });
    expect(sm).toHaveClass('appearance-none', 'select-chevron', 'pr-8', 'w-auto');
    expect(sm).not.toHaveClass('pr-9');
  });

  it('hands the arrow back to the platform in forced colors', () => {
    render(<Select aria-label="Role" />);
    expect(screen.getByRole('combobox', { name: 'Role' })).toHaveClass(
      'forced-colors:appearance-auto',
      'forced-colors:bg-none',
    );
  });
});
