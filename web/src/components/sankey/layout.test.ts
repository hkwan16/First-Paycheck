import { describe, expect, it } from 'vitest';
import { emptyCashflow, sampleCashflow } from '@/test/fixtures/cashflow';
import {
  layoutCashFlow,
  MIN_HOST_W,
  MIN_NODE_H,
  NODE_GAP,
  NODE_W,
  TARGET_GROSS_PX,
  type FlowLayout,
} from './layout';

const ids = (layout: FlowLayout, column: number) => layout.columns[column]!.map((node) => node.id);
const node = (layout: FlowLayout, id: string) => {
  const found = layout.nodes.find((n) => n.id === id);
  if (!found) throw new Error(`no node ${id}`);
  return found;
};
const outOf = (layout: FlowLayout, id: string) => layout.links.filter((l) => l.from === id);
const sumThickness = (links: FlowLayout['links']) =>
  links.reduce((total, link) => total + link.thickness, 0);

describe('layoutCashFlow', () => {
  const layout = layoutCashFlow(sampleCashflow(), 928);

  it('puts gross pay, then withholding and take-home, then buckets, then categories', () => {
    expect(ids(layout, 0)).toEqual(['gross']);
    expect(ids(layout, 1)).toEqual([
      'line:federal_withholding',
      'line:social_security',
      'line:medicare',
      'line:state_tax',
      'line:retirement_contribution',
      'line:medical_premium',
      'line:other_deductions',
      'take-home',
    ]);
    expect(ids(layout, 2)).toEqual([
      'bucket:essentials',
      'bucket:flexible',
      'bucket:savings',
      'bucket:left_over',
    ]);
    // Grouped by bucket, each bucket's categories in the API's order.
    expect(ids(layout, 3)).toEqual([
      'category:housing',
      'category:utilities',
      'category:phone_internet',
      'category:groceries',
      'category:transport',
      'category:dining',
      'category:subscriptions',
      'category:shopping',
      'category:savings_investment',
    ]);
  });

  it('names each node and carries the API amount in cents, untouched', () => {
    expect(node(layout, 'gross')).toMatchObject({ name: 'Gross pay, 2 stubs', cents: 541_666 });
    expect(node(layout, 'line:federal_withholding')).toMatchObject({
      name: 'Federal tax',
      cents: 59_552,
    });
    expect(node(layout, 'take-home')).toMatchObject({ name: 'Take-home', cents: 399_208 });
    expect(node(layout, 'bucket:left_over')).toMatchObject({
      name: 'Not yet spent',
      cents: 161_894,
    });
    expect(node(layout, 'category:phone_internet')).toMatchObject({
      name: 'Phone and internet',
      cents: 7_000,
    });
  });

  it('colors nodes with flow token names: plum pay, grey taxes, coral health, hue per bucket', () => {
    const color = (id: string) => node(layout, id).color;
    expect(color('gross')).toBe('plum');
    expect(color('line:federal_withholding')).toBe('flow-tax');
    expect(color('line:retirement_contribution')).toBe('plum');
    expect(color('line:medical_premium')).toBe('coral');
    expect(color('take-home')).toBe('ink-2');
    expect(color('bucket:essentials')).toBe('blue');
    expect(color('bucket:flexible')).toBe('coral');
    expect(color('bucket:savings')).toBe('teal');
    expect(color('bucket:left_over')).toBe('flow-idle');
    expect(color('category:housing')).toBe('blue-soft');
    expect(color('category:dining')).toBe('coral-soft');
    expect(color('category:savings_investment')).toBe('teal');
  });

  it('derives the scale from a target gross height, for the "1 px is about" badge', () => {
    expect(layout.scale).not.toBeNull();
    expect(layout.scale!.pxPerCent).toBeCloseTo(TARGET_GROSS_PX / 541_666, 12);
    // 541,666 cents over 400 px is 1,354.165 cents a pixel.
    expect(layout.scale!.centsPerPx).toBe(1_354);
    expect(node(layout, 'gross').valuePx).toBeCloseTo(TARGET_GROSS_PX, 6);
  });

  it('draws bands out of gross pay that add up to its height', () => {
    const bands = outOf(layout, 'gross');
    expect(bands.map((b) => b.to)).toEqual([
      'line:federal_withholding',
      'line:social_security',
      'line:medicare',
      'line:state_tax',
      'line:medical_premium',
      'line:other_deductions',
      'take-home',
    ]);
    expect(sumThickness(bands)).toBeCloseTo(node(layout, 'gross').valuePx, 6);
  });

  it('draws take-home into the buckets and each bucket into its categories', () => {
    expect(outOf(layout, 'take-home').map((b) => b.to)).toEqual([
      'bucket:essentials',
      'bucket:flexible',
      'bucket:savings',
      'bucket:left_over',
    ]);
    expect(sumThickness(outOf(layout, 'take-home'))).toBeCloseTo(
      node(layout, 'take-home').valuePx,
      6,
    );
    expect(outOf(layout, 'bucket:flexible').map((b) => b.to)).toEqual([
      'category:dining',
      'category:subscriptions',
      'category:shopping',
    ]);
    // Not yet spent stays put: no category of its own.
    expect(outOf(layout, 'bucket:left_over')).toEqual([]);
  });

  it('gives each band the color of where it goes, lighter for the greys', () => {
    const band = (to: string) => layout.links.find((l) => l.to === to)!;
    expect(band('line:federal_withholding')).toMatchObject({ color: 'flow-tax', quiet: true });
    expect(band('bucket:essentials')).toMatchObject({ color: 'blue', quiet: false });
    expect(band('bucket:essentials').d).toMatch(/^M \d+(\.\d)? [\d.]+ C .* Z$/);
  });

  it('shows a $0 401(k) as a dashed node with no band, and hides other $0 lines', () => {
    const k401 = node(layout, 'line:retirement_contribution');
    expect(k401).toMatchObject({ name: '401(k), not elected', cents: 0, zero: true });
    expect(layout.links.some((l) => l.to === k401.id)).toBe(false);

    const noOther = sampleCashflow();
    noOther.withholding.lines.find((l) => l.key === 'other_deductions')!.amount_cents = 0;
    expect(ids(layoutCashFlow(noOther, 928), 1)).not.toContain('line:other_deductions');
  });

  it('keeps every node at least the minimum height and stacks columns without overlap', () => {
    for (const column of layout.columns) {
      column.forEach((n, i) => {
        expect(n.h).toBeGreaterThanOrEqual(MIN_NODE_H);
        expect(n.h).toBeGreaterThanOrEqual(n.valuePx - 1e-9);
        const next = column[i + 1];
        if (next) expect(next.y).toBeCloseTo(n.y + n.h + NODE_GAP, 6);
      });
    }
    const bottom = Math.max(...layout.nodes.map((n) => n.y + n.h));
    expect(layout.hostH).toBeGreaterThan(bottom);
  });

  it('starts the buckets level with take-home and the categories level with the first bucket', () => {
    expect(node(layout, 'bucket:essentials').y).toBe(node(layout, 'take-home').y);
    expect(node(layout, 'category:housing').y).toBe(node(layout, 'bucket:essentials').y);
  });

  it('spreads four columns over the container, never narrower than the minimum', () => {
    expect(MIN_HOST_W).toBe(880);
    expect(layout.hostW).toBe(928);
    expect(layout.columnX[0]).toBe(4);
    expect(layout.columnX[3]).toBe(928 - 4 - NODE_W);
    expect(layout.nodes.every((n) => n.x === layout.columnX[n.column])).toBe(true);

    const narrow = layoutCashFlow(sampleCashflow(), 700);
    expect(narrow.hostW).toBe(880);
    expect(narrow.columnX[3]).toBe(880 - 4 - NODE_W);
    expect(layoutCashFlow(sampleCashflow(), 1100.7).hostW).toBe(1100);
  });

  it('without a confirmed pay stub, starts from the income deposited', () => {
    const flow = sampleCashflow({ pay_stubs: [] });
    flow.withholding = emptyCashflow(flow.start, flow.end).withholding;
    const noStubs = layoutCashFlow(flow, 928);

    expect(node(noStubs, 'gross')).toMatchObject({
      name: 'No confirmed pay stub',
      zero: true,
      cents: 0,
    });
    expect(ids(noStubs, 1)).toEqual(['take-home']);
    expect(node(noStubs, 'take-home')).toMatchObject({ name: 'Income deposited', cents: 399_208 });
    expect(outOf(noStubs, 'gross')).toEqual([]);
    // The scale now comes from the income.
    expect(noStubs.scale!.centsPerPx).toBe(998);
  });

  it('draws spending beyond income as a dashed node with no band', () => {
    const flow = sampleCashflow();
    flow.spending.left_over_cents = -12_345;
    const over = layoutCashFlow(flow, 928);
    expect(node(over, 'bucket:left_over')).toMatchObject({
      name: 'Spent beyond income',
      cents: -12_345,
      zero: true,
      valuePx: 0,
    });
    expect(over.links.some((l) => l.to === 'bucket:left_over')).toBe(false);
  });

  it('grows take-home to hold its bands when deposits differ from the stubs', () => {
    const flow = sampleCashflow();
    flow.spending.essentials_cents = 482_325;
    const grown = layoutCashFlow(flow, 928);
    const takeHome = node(grown, 'take-home');
    expect(takeHome.h).toBeCloseTo(sumThickness(outOf(grown, 'take-home')), 6);
    expect(takeHome.h).toBeGreaterThan(takeHome.valuePx);
  });

  it('shows a $0 bucket dashed with no band, and leaves an empty Other bucket out', () => {
    const flow = sampleCashflow();
    flow.spending.savings_cents = 0;
    flow.spending.categories = flow.spending.categories.filter(
      (c) => c.category !== 'savings_investment',
    );
    const noSavings = layoutCashFlow(flow, 928);
    expect(node(noSavings, 'bucket:savings')).toMatchObject({ zero: true, cents: 0 });
    expect(noSavings.links.some((l) => l.to === 'bucket:savings')).toBe(false);
    expect(ids(noSavings, 2)).not.toContain('bucket:other');
  });

  it('includes the Other bucket and its categories when it has spending', () => {
    const flow = sampleCashflow();
    flow.spending.other_cents = 3_900;
    flow.spending.categories.push({
      category: 'fees',
      bucket: 'other',
      total_cents: 3_900,
      count: 1,
    });
    const withOther = layoutCashFlow(flow, 928);
    expect(ids(withOther, 2)).toContain('bucket:other');
    expect(node(withOther, 'category:fees').color).toBe('flow-tax');
    expect(outOf(withOther, 'bucket:other').map((b) => b.to)).toEqual(['category:fees']);
  });

  it('leaves out categories with no net spending (refunds cancelled them)', () => {
    const flow = sampleCashflow();
    flow.spending.categories.push({
      category: 'travel',
      bucket: 'flexible',
      total_cents: -500,
      count: 2,
    });
    expect(ids(layoutCashFlow(flow, 928), 3)).not.toContain('category:travel');
  });

  it('has no scale when there is nothing to draw', () => {
    const empty = layoutCashFlow(emptyCashflow('2026-09-01', '2026-09-30'), 928);
    expect(empty.scale).toBeNull();
    expect(empty.links).toEqual([]);
    expect(empty.nodes.every((n) => n.h === MIN_NODE_H)).toBe(true);
  });
});
