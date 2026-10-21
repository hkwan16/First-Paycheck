import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KV, KVList } from './KV';

describe('KV and KVList', () => {
  it('renders a description list of label and tabular value rows', () => {
    const { container } = render(
      <KVList>
        <KV label="Saved so far" value="$2,140.00" />
        <KV label="Still to save" value="$3,329.75" />
      </KVList>,
    );
    expect(container.firstElementChild?.tagName).toBe('DL');
    expect(screen.getByText('Saved so far').tagName).toBe('DT');
    const value = screen.getByText('$2,140.00');
    expect(value.closest('dd')).toHaveClass('tabular-nums');
  });

  it('rules each row with a hairline except the first', () => {
    render(
      <KVList>
        <KV label="a" value="1" />
        <KV label="b" value="2" />
      </KVList>,
    );
    const row = screen.getByText('a').parentElement;
    expect(row).toHaveClass('border-t', 'border-line', 'first:border-t-0', 'py-1.5');
  });

  it('keeps the first rule when the list follows a headline', () => {
    const { container } = render(
      <KVList rules="all">
        <KV label="a" value="1" />
      </KVList>,
    );
    expect(container.firstElementChild).toHaveClass('[&>div:first-child]:border-t');
  });

  it('spaces rows more comfortably on reading screens', () => {
    const { container } = render(
      <KVList spacing="comfortable">
        <KV label="a" value="1" />
      </KVList>,
    );
    expect(container.firstElementChild).toHaveClass('[&>div]:py-2', '[&>div:first-child]:pt-0');
  });

  it('marks a value the verifier matched to the calculator', () => {
    render(
      <KVList>
        <KV label="Salary" value="$65,000" verified />
      </KVList>,
    );
    const dd = screen.getByText('$65,000').closest('dd') as HTMLElement;
    const mark = within(dd).getByLabelText('matches calculator');
    expect(mark).toHaveTextContent('=');
    expect(mark).toHaveClass('bg-green-tint', 'text-green-text');
  });
});
