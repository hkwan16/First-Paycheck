import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FieldError } from './FieldError';

describe('FieldError', () => {
  it('renders the message with an id for aria-describedby, in the invalid field color', () => {
    render(<FieldError id="email-error">Enter your email address.</FieldError>);
    const message = screen.getByText('Enter your email address.');
    expect(message).toHaveAttribute('id', 'email-error');
    expect(message).toHaveClass('text-small', 'text-red-text');
  });

  it('renders nothing without a message, so the form keeps its spacing', () => {
    const { container } = render(<FieldError id="email-error">{null}</FieldError>);
    expect(container).toBeEmptyDOMElement();
  });
});
