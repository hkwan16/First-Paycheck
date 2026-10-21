import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Checkbox } from './Checkbox';

describe('Checkbox', () => {
  it('is a 44px tall labeled checkbox', async () => {
    const onChange = vi.fn();
    render(
      <Checkbox checked={false} onChange={onChange}>
        Step 2(c): I have a second job
      </Checkbox>,
    );
    const box = screen.getByRole('checkbox', { name: 'Step 2(c): I have a second job' });
    expect(box.closest('label')).toHaveClass('min-h-11');
    expect(box).toHaveClass('size-5', 'accent-blue');
    await userEvent.click(screen.getByText('Step 2(c): I have a second job'));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
