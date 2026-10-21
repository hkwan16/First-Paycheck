import { describe, expect, it } from 'vitest';
import { sampleCashflow } from '@/test/fixtures/cashflow';
import { render, screen, within } from '@/test/render';
import { FlowStack } from './FlowStack';

describe('FlowStack', () => {
  it('stacks one section per stage: gross pay, take-home, then each bucket', () => {
    render(<FlowStack flow={sampleCashflow()} />);
    const sections = screen.getAllByRole('region');
    expect(sections.map((s) => s.getAttribute('aria-label'))).toEqual([
      'Gross pay, 2 stubs',
      'Take-home',
      'Essentials',
      'Flexible',
      'Savings',
    ]);
  });

  it('heads each stage with its amount and lists where it went, amounts as the API sent them', () => {
    render(<FlowStack flow={sampleCashflow()} />);
    const gross = screen.getByRole('region', { name: 'Gross pay, 2 stubs' });
    expect(within(gross).getByRole('heading', { level: 3 })).toHaveTextContent(
      'Gross pay, 2 stubs$5,416.66',
    );
    const items = within(gross).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      'Federal tax$595.52',
      'Social Security$335.84',
      'Medicare$78.54',
      'State tax$196.28',
      '401(k), not elected$0.00',
      'Health premiums$125.00',
      'Other deductions$93.40',
      'Take-home$3,992.08',
    ]);
  });

  it('draws a decorative stacked bar whose segments the browser sizes from the cents', () => {
    const { container } = render(<FlowStack flow={sampleCashflow()} />);
    const bar = container.querySelector('[data-flow-bar="take-home"]')!;
    expect(bar).toHaveAttribute('aria-hidden', 'true');
    const segments = [...bar.children] as HTMLElement[];
    expect(segments.map((s) => s.style.flexGrow)).toEqual(['182325', '24989', '30000', '161894']);
    expect(segments[0]).toHaveClass('bg-blue');
    expect(segments[3]).toHaveClass('bg-flow-idle');
  });

  it('lists a $0 item with a dashed swatch and leaves it out of the bar', () => {
    const { container } = render(<FlowStack flow={sampleCashflow()} />);
    const gross = screen.getByRole('region', { name: 'Gross pay, 2 stubs' });
    const k401 = within(gross).getByText('401(k), not elected').closest('li')!;
    expect(k401.querySelector('i')).toHaveClass('border-dashed');
    expect(container.querySelector('[data-flow-bar="gross"]')!.children).toHaveLength(7);
  });
});
