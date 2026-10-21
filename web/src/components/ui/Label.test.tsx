import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Label } from './Label';
import { Input } from './Input';

describe('Label', () => {
  it('labels its control in the 13px semibold style', () => {
    render(
      <>
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" />
      </>,
    );
    expect(screen.getByText('Email')).toHaveClass('text-small', 'font-semibold', 'text-ink-2');
    expect(screen.getByLabelText('Email')).toHaveAttribute('type', 'email');
  });

  it('puts a value at the far end of the row', () => {
    render(
      <Label htmlFor="k" aside="4% of salary">
        Your contribution
      </Label>,
    );
    const label = screen.getByText('Your contribution').closest('label');
    expect(label).toHaveClass('flex', 'justify-between');
    expect(screen.getByText('4% of salary')).toHaveClass('tabular-nums');
  });
});
