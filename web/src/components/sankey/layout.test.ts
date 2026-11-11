import { describe, expect, it } from 'vitest';
import type { CashFlow } from '@/lib/api/types';
import {
  beyondCashflow,
  dynamicCashflow,
  emptyCashflow,
  notDepositedCashflow,
  sampleCashflow,
  sandboxCashflow,
  septemberCashflow,
} from '@/test/fixtures/cashflow';
import {
  flowScale,
  layoutCashFlow,
  legendFor,
  placePopover,
  POPOVER_W,
  MIN_BAND_PX,
  MIN_HOST_W,
  MIN_NODE_H,
  NODE_GAP,
  NODE_W,
  TARGET_GROSS_PX,
  TOP,
  type FlowLayout,
} from './layout';

const ids = (layout: FlowLayout, column: number) => layout.columns[column]!.map((node) => node.id);
const node = (layout: FlowLayout, id: string) => {
  const found = layout.nodes.find((n) => n.id === id);
  if (!found) throw new Error(`no node ${id}`);
  return found;
};
const outOf = (layout: FlowLayout, id: string) => layout.links.filter((l) => l.from === id);
const into = (layout: FlowLayout, id: string) => layout.links.filter((l) => l.to === id);

/** The pixels each band stands for (its cents at the scale), before any minimum. */
const bandPx = (layout: FlowLayout, links: FlowLayout['links']) =>
  links.reduce((total, link) => total + link.cents * layout.scale!.pxPerCent, 0);

/** Rule 5b: a node is as tall as its amount, and so are the bands in and out of it. */
function expectEveryNodeIsItsAmount(layout: FlowLayout) {
  for (const n of layout.nodes) {
    expect(n.h).toBeCloseTo(Math.max(MIN_NODE_H, n.valuePx), 6);
    if (n.zero) continue;
    expect(n.valuePx).toBeCloseTo(n.cents * layout.scale!.pxPerCent, 6);
    const ins = into(layout, n.id);
    const outs = outOf(layout, n.id);
    if (ins.length > 0) expect(bandPx(layout, ins)).toBeCloseTo(n.valuePx, 6);
    if (outs.length > 0) expect(bandPx(layout, outs)).toBeCloseTo(n.valuePx, 6);
  }
}

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
      'take_home',
    ]);
    expect(ids(layout, 2)).toEqual([
      'bucket:essentials',
      'bucket:flexible',
      'bucket:savings',
      'left_over',
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
    expect(node(layout, 'take_home')).toMatchObject({ name: 'Take-home', cents: 399_208 });
    expect(node(layout, 'left_over')).toMatchObject({ name: 'Left over', cents: 161_894 });
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
    expect(color('take_home')).toBe('ink-2');
    expect(color('bucket:essentials')).toBe('blue');
    expect(color('bucket:flexible')).toBe('coral');
    expect(color('bucket:savings')).toBe('teal');
    expect(color('left_over')).toBe('flow-idle');
    expect(color('category:housing')).toBe('blue-soft');
    expect(color('category:dining')).toBe('coral-soft');
    expect(color('category:savings_investment')).toBe('teal');
  });

  it('derives the scale from a target height for the largest node, for the "1 px is about" badge', () => {
    expect(layout.scale).not.toBeNull();
    expect(layout.scale!.pxPerCent).toBeCloseTo(TARGET_GROSS_PX / 541_666, 12);
    // 541,666 cents over 240 px is 2,256.94 cents a pixel.
    expect(layout.scale!.centsPerPx).toBe(2_257);
    expect(node(layout, 'gross').valuePx).toBeCloseTo(TARGET_GROSS_PX, 6);
  });

  it('draws the bands the API gives, in its order', () => {
    expect(outOf(layout, 'gross').map((b) => b.to)).toEqual([
      'line:federal_withholding',
      'line:social_security',
      'line:medicare',
      'line:state_tax',
      'line:medical_premium',
      'line:other_deductions',
      'take_home',
    ]);
    expect(outOf(layout, 'take_home').map((b) => b.to)).toEqual([
      'bucket:essentials',
      'bucket:flexible',
      'bucket:savings',
      'left_over',
    ]);
    expect(outOf(layout, 'bucket:flexible').map((b) => b.to)).toEqual([
      'category:dining',
      'category:subscriptions',
      'category:shopping',
    ]);
    expect(outOf(layout, 'left_over')).toEqual([]);
  });

  it('makes every node as tall as its amount and its bands add up to it (spec 010 rule 5b)', () => {
    expectEveryNodeIsItsAmount(layout);
  });

  it('gives each band the color of where it goes, lighter for the greys', () => {
    const band = (to: string) => layout.links.find((l) => l.to === to)!;
    expect(band('line:federal_withholding')).toMatchObject({ color: 'flow-tax', quiet: true });
    expect(band('bucket:essentials')).toMatchObject({ color: 'blue', quiet: false });
    expect(band('bucket:essentials').d).toMatch(/^M \d+(\.\d)? [\d.]+ C .* Z$/);
  });

  it('stacks the bands along a node from its top, and draws a tiny one at the minimum', () => {
    const takeHome = node(layout, 'take_home');
    const [first, second] = outOf(layout, 'take_home');
    const top = takeHome.y + (takeHome.h - takeHome.valuePx) / 2;
    expect(first!.d.startsWith(`M ${takeHome.x + NODE_W} ${Math.round(top * 10) / 10} `)).toBe(
      true,
    );
    expect(second!.thickness).toBeCloseTo(24_989 * layout.scale!.pxPerCent, 6);
    // The sandbox's 4.22 of income is under a pixel at its scale.
    const tiny = layoutCashFlow(sandboxCashflow(), 928);
    expect(outOf(tiny, 'income_deposited')[0]!.thickness).toBe(MIN_BAND_PX);
  });

  it('shows a $0 401(k) as a dashed node with no band, and hides other $0 lines', () => {
    const k401 = node(layout, 'line:retirement_contribution');
    expect(k401).toMatchObject({ name: '401(k), not elected', cents: 0, zero: true });
    expect(layout.links.some((l) => l.to === k401.id)).toBe(false);

    const noOther = sampleCashflow();
    noOther.diagram.nodes.find((n) => n.id === 'line:other_deductions')!.cents = 0;
    noOther.diagram.links = noOther.diagram.links.filter(
      (l) => l.target !== 'line:other_deductions',
    );
    expect(ids(layoutCashFlow(noOther, 928), 1)).not.toContain('line:other_deductions');
  });

  it('keeps every node at least the minimum height and stacks columns without overlap', () => {
    for (const column of layout.columns) {
      column.forEach((n, i) => {
        expect(n.h).toBeGreaterThanOrEqual(MIN_NODE_H);
        const next = column[i + 1];
        if (next) expect(next.y).toBeCloseTo(n.y + n.h + NODE_GAP, 6);
      });
    }
    const bottom = Math.max(...layout.nodes.map((n) => n.y + n.h));
    expect(layout.hostH).toBeGreaterThan(bottom);
  });

  it('starts every column at the top, so it is as tall as its tallest column (issue 201)', () => {
    expect(layout.columns.map((column) => column[0]!.y)).toEqual([TOP, TOP, TOP, TOP]);
    const bottom = Math.max(...layout.nodes.map((n) => n.y + n.h));
    expect(layout.hostH).toBe(Math.ceil(bottom) + 12);
    // Two pay stubs, seven withholding lines and nine categories, in under one screen.
    expect(layout.hostH).toBe(525);
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

  it('issue 236: take-home is drawn shorter than gross pay, and other money pays the rest', () => {
    // One stub: gross 2,708.33, take-home 1,996.04; 3,240.12 deposited, 5,234.98 spent.
    const beyond = layoutCashFlow(beyondCashflow(), 1344);
    const gross = node(beyond, 'gross');
    const takeHome = node(beyond, 'take_home');
    expect(gross).toMatchObject({ name: 'Gross pay, 1 stub', cents: 270_833 });
    expect(takeHome).toMatchObject({ name: 'Take-home', cents: 199_604 });
    expect(takeHome.h).toBeLessThan(gross.h);
    expect(takeHome.h / gross.h).toBeCloseTo(199_604 / 270_833, 6);
    expect(ids(beyond, 1).slice(-3)).toEqual(['take_home', 'other_deposits', 'beyond_income']);
    expect(node(beyond, 'other_deposits')).toMatchObject({
      name: 'Other deposits',
      cents: 124_408,
      color: 'ink-2',
    });
    expect(node(beyond, 'beyond_income')).toMatchObject({
      name: 'Spent beyond income',
      cents: 199_486,
      color: 'flow-idle',
      zero: false,
    });
    expect(ids(beyond, 2)).not.toContain('left_over');
    expect(outOf(beyond, 'take_home').map((b) => [b.to, b.cents])).toEqual([
      ['bucket:essentials', 199_604],
    ]);
    expect(into(beyond, 'bucket:flexible').map((b) => [b.from, b.cents])).toEqual([
      ['other_deposits', 14_012],
      ['beyond_income', 197_332],
    ]);
    expectEveryNodeIsItsAmount(beyond);
  });

  it('sends take-home that was not deposited to its own node', () => {
    const short = layoutCashFlow(notDepositedCashflow(), 928);
    expect(ids(short, 2)[0]).toBe('not_deposited');
    expect(node(short, 'not_deposited')).toMatchObject({
      name: 'Not deposited',
      cents: 49_604,
      color: 'flow-idle',
    });
    expect(outOf(short, 'take_home').map((b) => b.to)).toEqual([
      'not_deposited',
      'bucket:essentials',
      'left_over',
    ]);
    expectEveryNodeIsItsAmount(short);
  });

  it('without a confirmed pay stub, starts from the income deposited', () => {
    const dynamic = layoutCashFlow(dynamicCashflow(), 928);
    expect(node(dynamic, 'gross')).toMatchObject({
      name: 'No pay stub this period',
      zero: true,
      cents: 0,
    });
    expect(ids(dynamic, 1)).toEqual(['income_deposited', 'refunds']);
    expect(node(dynamic, 'income_deposited')).toMatchObject({
      name: 'Income deposited',
      cents: 12,
    });
    expect(outOf(dynamic, 'gross')).toEqual([]);
  });

  it('draws money back in a category as a source, and the bucket before it', () => {
    // The sandbox's United Airlines refund (500.00) outweighed October's travel.
    const sandbox = layoutCashFlow(sandboxCashflow(), 928);
    expect(ids(sandbox, 1)).toEqual(['income_deposited', 'refunds', 'beyond_income']);
    expect(node(sandbox, 'refunds')).toMatchObject({
      name: 'Refunds',
      cents: 50_000,
      categories: ['travel'],
    });
    expect(node(sandbox, 'bucket:flexible')).toMatchObject({
      cents: 118_423,
      refundsCents: 50_000,
    });
    expect(ids(sandbox, 3)).not.toContain('category:travel');
    // The largest node sets the scale: spending beyond the income, 1,685.41, at 240 px.
    expect(node(sandbox, 'beyond_income').valuePx).toBeCloseTo(TARGET_GROSS_PX, 6);
    expect(sandbox.scale!.centsPerPx).toBe(702);
    expectEveryNodeIsItsAmount(sandbox);
  });

  it('shows a $0 bucket dashed with no band, and leaves an empty Other bucket out', () => {
    const short = layoutCashFlow(notDepositedCashflow(), 928);
    expect(node(short, 'bucket:savings')).toMatchObject({ zero: true, cents: 0 });
    expect(short.links.some((l) => l.to === 'bucket:savings')).toBe(false);
    expect(ids(short, 2)).not.toContain('bucket:other');
  });

  it('includes the Other bucket and its categories when it has spending', () => {
    const september = layoutCashFlow(septemberCashflow(), 928);
    expect(ids(september, 2)).toContain('bucket:other');
    expect(node(september, 'category:fees').color).toBe('flow-tax');
    expect(outOf(september, 'bucket:other').map((b) => b.to)).toEqual(['category:fees']);
  });

  it('has no scale when there is nothing to draw', () => {
    const empty = layoutCashFlow(emptyCashflow('2026-09-01', '2026-09-30'), 928);
    expect(empty.scale).toBeNull();
    expect(empty.links).toEqual([]);
    expect(empty.nodes.every((n) => n.h === MIN_NODE_H)).toBe(true);
  });
});

describe('flowScale', () => {
  it('is the layout scale, whatever the width', () => {
    expect(flowScale(sampleCashflow())).toEqual(layoutCashFlow(sampleCashflow(), 1200).scale);
    expect(flowScale(emptyCashflow('2026-09-01', '2026-09-30'))).toBeNull();
  });
});

describe('legendFor', () => {
  const legend = (flow: CashFlow) => legendFor(layoutCashFlow(flow, 928));

  it('lists the groups the diagram draws with an amount, in a fixed color order', () => {
    expect(legend(sampleCashflow())).toEqual([
      { color: 'plum', label: 'Gross pay' },
      { color: 'flow-tax', label: 'Taxes and other deductions' },
      { color: 'coral', label: 'Health premiums and flexible spending' },
      { color: 'ink-2', label: 'Take-home' },
      { color: 'blue', label: 'Essentials' },
      { color: 'teal', label: 'Savings' },
      { color: 'flow-idle', label: 'Left over' },
    ]);
  });

  it('lists no pay stub group for a period with no stub (issue 236)', () => {
    expect(legend(sandboxCashflow())).toEqual([
      { color: 'coral', label: 'Flexible spending' },
      { color: 'ink-2', label: 'Income deposited and refunds' },
      { color: 'blue', label: 'Essentials' },
      { color: 'teal', label: 'Savings' },
      { color: 'flow-idle', label: 'Spent beyond income' },
    ]);
  });

  it('names the other sources and uses when they are drawn', () => {
    expect(legend(beyondCashflow())).toContainEqual({
      color: 'ink-2',
      label: 'Take-home and other deposits',
    });
    expect(legend(notDepositedCashflow())).toContainEqual({
      color: 'flow-idle',
      label: 'Not deposited and left over',
    });
    expect(legend(septemberCashflow())).toContainEqual({
      color: 'flow-tax',
      label: 'Taxes, other deductions and other spending',
    });
  });

  it('is empty for an empty period', () => {
    expect(legend(emptyCashflow('2026-09-01', '2026-09-30'))).toEqual([]);
  });
});

describe('placePopover', () => {
  const layout = layoutCashFlow(sampleCashflow(), 928);

  it('opens to the right of a node, level with its top', () => {
    const gross = node(layout, 'gross');
    expect(placePopover(gross, layout, 120)).toEqual({
      left: gross.x + NODE_W + 10,
      top: gross.y,
      side: 'right',
    });
  });

  it('opens to the left when the right would leave the host', () => {
    const housing = node(layout, 'category:housing');
    expect(placePopover(housing, layout, 120)).toMatchObject({
      left: housing.x - 10 - POPOVER_W,
      side: 'left',
    });
  });

  it('moves up to stay inside the host, never above its top edge', () => {
    const last = node(layout, 'category:savings_investment');
    expect(placePopover(last, layout, 200).top).toBe(layout.hostH - 4 - 200);
    expect(placePopover(last, layout, 5_000).top).toBe(4);
  });
});
