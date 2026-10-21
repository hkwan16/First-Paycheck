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
});
