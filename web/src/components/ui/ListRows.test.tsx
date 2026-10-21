import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ListRows } from './ListRows';

describe('ListRows', () => {
  it('stacks rows with hairlines between them', () => {
    const { container } = render(
      <ListRows>
        <div>Chase Total Checking</div>
        <div>Chase Savings</div>
      </ListRows>,
    );
    expect(container.firstElementChild).toHaveClass(
      'flex',
      'flex-col',
      '[&>*]:border-t',
      '[&>*]:border-line',
      '[&>*]:py-3.5',
      '[&>*:first-child]:border-t-0',
      '[&>*:first-child]:pt-0',
      '[&>*:last-child]:pb-0',
    );
    expect(screen.getByText('Chase Savings')).toBeInTheDocument();
  });

  it('renders as a list when the rows are list items', () => {
    render(
      <ListRows as="ul" aria-label="Documents">
        <li>Pay stub</li>
      </ListRows>,
    );
    expect(screen.getByRole('list', { name: 'Documents' })).toHaveClass('list-none', 'p-0');
  });
});
