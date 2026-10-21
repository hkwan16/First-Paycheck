import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PageTitle } from './PageTitle';

describe('PageTitle', () => {
  it('renders the page heading and lead', () => {
    render(
      <PageTitle
        title="Link your accounts and add your documents"
        lead="Both feed one pipeline."
      />,
    );
    expect(
      screen.getByRole('heading', { level: 1, name: 'Link your accounts and add your documents' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Both feed one pipeline.')).toHaveClass('text-ink-3', 'mt-1.5');
  });

  it('puts an aside at the end of the row, aligned to the bottom', () => {
    render(<PageTitle title="Four decisions" aside={<span>0 of 4 saved</span>} />);
    const row = screen.getByText('0 of 4 saved').parentElement;
    expect(row).toHaveClass('flex', 'justify-between', 'items-end', 'flex-wrap');
  });

  it('shows an eyebrow above the title', () => {
    render(<PageTitle title="Why" eyebrow={<span>401(k) match · decision v1</span>} />);
    const eyebrow = screen.getByText('401(k) match · decision v1');
    expect(eyebrow.compareDocumentPosition(screen.getByRole('heading'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});
