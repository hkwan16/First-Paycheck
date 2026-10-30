import type { CashFlow, SpendingBucket, WithholdingLine } from '@/lib/api/types';
import { categoryLabel } from '@/lib/categories';
import { isQuietFlow, type FlowColor } from '@/lib/design/tone';

/*
 * The cash-flow diagram's geometry, ported from the construction in
 * docs/mockup/Spending.dc.html: four columns of absolutely positioned HTML
 * nodes joined by one SVG of cubic bands.
 *
 *   0  gross pay            (the period's confirmed pay stubs)
 *   1  withholding lines, then take-home
 *   2  buckets: essentials, flexible, savings, other, not yet spent
 *   3  each bucket's categories
 *
 * Every amount is the API's (`GET /cashflow`), carried in cents and shown
 * as is. This module only turns cents into pixels: heights are cents times
 * one scale, which comes from a target height for the first column's
 * amount, so "1 px is about $N" is computed rather than printed. Nothing it
 * computes is ever shown as money except that scale.
 */

/** Node width and the narrowest gap between columns. */
export const NODE_W = 176;
export const COL_GAP_MIN = 56;
/** Room kept clear at the host's left and right edges (for the focus ring). */
export const EDGE = 4;
/** The host never gets narrower than four nodes and three gaps; below it scrolls. */
export const MIN_HOST_W = 4 * NODE_W + 3 * COL_GAP_MIN + 2 * EDGE;
/** A node is tall enough for its name and amount, however small the amount. */
export const MIN_NODE_H = 36;
export const NODE_GAP = 8;
/** Space above the first node for the column headings. */
export const TOP = 28;
const BOTTOM = 12;
/** How tall gross pay is drawn; the scale follows from it. */
export const TARGET_GROSS_PX = 400;
/** The thinnest band drawn, so a few dollars still show. */
export const MIN_BAND_PX = 1.5;

export type FlowColumn = 0 | 1 | 2 | 3;

export type FlowNodeKind = 'gross' | 'line' | 'take-home' | 'bucket' | 'category';

/** Bucket nodes: the spending buckets plus what was left over. */
export type FlowBucket = Exclude<SpendingBucket, 'income' | 'transfer'> | 'left_over';

export interface FlowNode {
  /** Stable across renders: `gross`, `line:<key>`, `take-home`, `bucket:<b>`, `category:<c>`. */
  id: string;
  kind: FlowNodeKind;
  column: FlowColumn;
  name: string;
  /** The API's amount, untouched. */
  cents: number;
  color: FlowColor;
  /** Drawn dashed with no band: nothing (or less than nothing) flowed here. */
  zero: boolean;
  x: number;
  y: number;
  /** The node's height: at least MIN_NODE_H, its own band, and its outgoing bands. */
  h: number;
  /** The node's amount in pixels (0 for a zero node). */
  valuePx: number;
  /** The withholding line, bucket or category the node stands for. */
  key: string;
}

export interface FlowLink {
  id: string;
  from: string;
  to: string;
  color: FlowColor;
  /** A grey band, drawn lighter. */
  quiet: boolean;
  thickness: number;
  /** SVG path: two cubic curves closed into a band. */
  d: string;
}

export interface FlowScale {
  pxPerCent: number;
  /** The badge's "1 px is about": whole cents. */
  centsPerPx: number;
}

export interface FlowLayout {
  hostW: number;
  hostH: number;
  nodeW: number;
  columnX: readonly [number, number, number, number];
  /** Every node, column by column, top to bottom. */
  nodes: FlowNode[];
  /** The same nodes grouped by column (keyboard movement, headings). */
  columns: readonly [FlowNode[], FlowNode[], FlowNode[], FlowNode[]];
  links: FlowLink[];
  /** Null when there is no money to draw. */
  scale: FlowScale | null;
}

const LINE_COLOR: Record<WithholdingLine['role'], FlowColor> = {
  tax: 'flow-tax',
  retirement: 'plum',
  health: 'coral',
  other: 'flow-tax',
};

interface BucketSpec {
  bucket: FlowBucket;
  name: string;
  color: FlowColor;
  /** Its categories' shade. */
  categoryColor: FlowColor;
  cents: (flow: CashFlow) => number;
  /** Leave the bucket out entirely when it is $0 (instead of a dashed node). */
  hideWhenZero?: boolean;
}

const BUCKETS: readonly BucketSpec[] = [
  {
    bucket: 'essentials',
    name: 'Essentials',
    color: 'blue',
    categoryColor: 'blue-soft',
    cents: (f) => f.spending.essentials_cents,
  },
  {
    bucket: 'flexible',
    name: 'Flexible',
    color: 'coral',
    categoryColor: 'coral-soft',
    cents: (f) => f.spending.flexible_cents,
  },
  {
    bucket: 'savings',
    name: 'Savings',
    color: 'teal',
    categoryColor: 'teal',
    cents: (f) => f.spending.savings_cents,
  },
  {
    bucket: 'other',
    name: 'Other',
    color: 'flow-tax',
    categoryColor: 'flow-tax',
    cents: (f) => f.spending.other_cents,
    hideWhenZero: true,
  },
  {
    bucket: 'left_over',
    name: 'Not yet spent',
    color: 'flow-idle',
    categoryColor: 'flow-idle',
    cents: (f) => f.spending.left_over_cents,
  },
];

/** One decimal place is plenty for an SVG path and keeps it short. */
const r = (value: number) => Math.round(value * 10) / 10;

function bandPath(x1: number, ya: number, x2: number, yb: number, t: number): string {
  const xm = (x1 + x2) / 2;
  return [
    `M ${x1} ${r(ya)}`,
    `C ${xm} ${r(ya)}, ${xm} ${r(yb)}, ${x2} ${r(yb)}`,
    `L ${x2} ${r(yb + t)}`,
    `C ${xm} ${r(yb + t)}, ${xm} ${r(ya + t)}, ${x1} ${r(ya + t)}`,
    'Z',
  ].join(' ');
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/** The buckets drawn in column 2, whose categories fill column 3. */
const DRAWN_BUCKETS: ReadonlySet<string> = new Set(BUCKETS.map((spec) => spec.bucket));

/**
 * Pixels per cent, from a target height for the tallest node: gross pay, or
 * the deposits when no pay stub is confirmed for the period, unless a bucket
 * or category the diagram draws is taller. Spending can outrun the income it
 * flows from (the Plaid sandbox deposits 4.22 in a month that spends 1,689.63),
 * and scaled by that income alone a node would be tens of thousands of pixels
 * tall. Picking the largest amount only sizes pixels; nothing is added and no
 * amount shown changes. Null when there is no pay or income to draw from.
 */
export function flowScale(flow: CashFlow): FlowScale | null {
  const pay =
    flow.withholding.paycheck_count > 0 ? flow.withholding.gross_cents : flow.spending.income_cents;
  if (pay <= 0) return null;
  const reference = Math.max(
    pay,
    ...BUCKETS.map((spec) => spec.cents(flow)),
    ...flow.spending.categories
      .filter((total) => DRAWN_BUCKETS.has(total.bucket))
      .map((total) => total.total_cents),
  );
  return {
    pxPerCent: TARGET_GROSS_PX / reference,
    centsPerPx: Math.round(reference / TARGET_GROSS_PX),
  };
}

/** The popover's width; its height is measured. */
export const POPOVER_W = 300;
const POPOVER_OFFSET = 10;
const POPOVER_INSET = 4;

export interface PopoverPlacement {
  left: number;
  top: number;
  /** Which side of the node it opens on (its transform origin). */
  side: 'left' | 'right';
}

/** Beside the node, right unless that leaves the host, and inside the host vertically. */
export function placePopover(node: FlowNode, layout: FlowLayout, height: number): PopoverPlacement {
  let left = node.x + layout.nodeW + POPOVER_OFFSET;
  let side: PopoverPlacement['side'] = 'right';
  if (left + POPOVER_W > layout.hostW) {
    left = node.x - POPOVER_OFFSET - POPOVER_W;
    side = 'left';
  }
  let top = node.y;
  if (top + height > layout.hostH - POPOVER_INSET) {
    top = Math.max(POPOVER_INSET, layout.hostH - POPOVER_INSET - height);
  }
  return { left, top, side };
}

/** Lay out the `GET /cashflow` response for a container `containerWidth` px wide. */
export function layoutCashFlow(flow: CashFlow, containerWidth: number): FlowLayout {
  const hostW = Math.max(MIN_HOST_W, Math.floor(containerWidth || 0));
  const step = (hostW - 2 * EDGE - NODE_W) / 3;
  const columnX = [0, 1, 2, 3].map((i) => Math.round(EDGE + i * step)) as unknown as readonly [
    number,
    number,
    number,
    number,
  ];

  const stubs = flow.withholding.paycheck_count;
  const scale = flowScale(flow);
  const px = (cents: number) => (scale && cents > 0 ? cents * scale.pxPerCent : 0);

  const nodes: FlowNode[] = [];
  const children = new Map<string, FlowNode[]>();
  const make = (
    column: FlowColumn,
    id: string,
    kind: FlowNodeKind,
    key: string,
    name: string,
    cents: number,
    color: FlowColor,
    parent: FlowNode | null,
  ): FlowNode => {
    const valuePx = px(cents);
    const node: FlowNode = {
      id,
      kind,
      column,
      key,
      name,
      cents,
      color,
      zero: valuePx === 0,
      x: columnX[column],
      y: 0,
      h: 0,
      valuePx,
    };
    nodes.push(node);
    if (parent && !node.zero) children.set(parent.id, [...(children.get(parent.id) ?? []), node]);
    return node;
  };

  const gross =
    stubs > 0
      ? make(
          0,
          'gross',
          'gross',
          'gross',
          `Gross pay, ${stubs} ${plural(stubs, 'stub', 'stubs')}`,
          flow.withholding.gross_cents,
          'plum',
          null,
        )
      : // None paid in this period; the user may have one from another (spec 010 rule 5a).
        make(0, 'gross', 'gross', 'gross', 'No pay stub this period', 0, 'plum', null);

  const lineNodes: FlowNode[] = [];
  if (stubs > 0) {
    for (const line of flow.withholding.lines) {
      const isRetirement = line.key === 'retirement_contribution';
      if (line.amount_cents <= 0 && !isRetirement) continue;
      const name = line.amount_cents <= 0 ? `${line.label}, not elected` : line.label;
      lineNodes.push(
        make(
          1,
          `line:${line.key}`,
          'line',
          line.key,
          name,
          line.amount_cents,
          LINE_COLOR[line.role],
          gross,
        ),
      );
    }
  }
  const takeHome =
    stubs > 0
      ? make(
          1,
          'take-home',
          'take-home',
          'take-home',
          'Take-home',
          flow.withholding.net_cents,
          'ink-2',
          gross,
        )
      : make(
          1,
          'take-home',
          'take-home',
          'take-home',
          'Income deposited',
          flow.spending.income_cents,
          'ink-2',
          null,
        );

  const bucketNodes: FlowNode[] = [];
  const categoryNodes: FlowNode[] = [];
  for (const spec of BUCKETS) {
    const cents = spec.cents(flow);
    if (spec.hideWhenZero && cents === 0) continue;
    const overspent = spec.bucket === 'left_over' && cents < 0;
    const bucket = make(
      2,
      `bucket:${spec.bucket}`,
      'bucket',
      spec.bucket,
      overspent ? 'Spent beyond income' : spec.name,
      cents,
      spec.color,
      takeHome,
    );
    bucketNodes.push(bucket);
    for (const total of flow.spending.categories) {
      if (total.bucket !== spec.bucket || total.total_cents <= 0) continue;
      categoryNodes.push(
        make(
          3,
          `category:${total.category}`,
          'category',
          total.category,
          categoryLabel(total.category),
          total.total_cents,
          spec.categoryColor,
          bucket,
        ),
      );
    }
  }

  const thickness = (node: FlowNode) => Math.max(node.valuePx, MIN_BAND_PX);
  const outPx = (node: FlowNode) =>
    (children.get(node.id) ?? []).reduce((total, child) => total + thickness(child), 0);
  for (const node of nodes) node.h = Math.max(MIN_NODE_H, node.valuePx, outPx(node));

  const stack = (column: FlowNode[], top: number) => {
    let y = top;
    for (const node of column) {
      node.y = y;
      y += node.h + NODE_GAP;
    }
  };
  const columns: FlowLayout['columns'] = [
    [gross],
    [...lineNodes, takeHome],
    bucketNodes,
    categoryNodes,
  ];
  stack(columns[0], TOP);
  stack(columns[1], TOP);
  stack(columns[2], takeHome.y);
  stack(columns[3], bucketNodes[0]?.y ?? TOP);

  const links: FlowLink[] = [];
  for (const parent of nodes) {
    const kids = children.get(parent.id);
    if (!kids) continue;
    let ya = parent.y + (parent.h - outPx(parent)) / 2;
    const x1 = parent.x + NODE_W;
    for (const child of kids) {
      const t = thickness(child);
      const yb = child.y + (child.h - t) / 2;
      links.push({
        id: `${parent.id}>${child.id}`,
        from: parent.id,
        to: child.id,
        color: child.color,
        quiet: isQuietFlow(child.color),
        thickness: t,
        d: bandPath(x1, ya, child.x, yb, t),
      });
      ya += t;
    }
  }

  const bottom = Math.max(...nodes.map((n) => n.y + n.h));
  return {
    hostW,
    hostH: Math.ceil(bottom) + BOTTOM,
    nodeW: NODE_W,
    columnX,
    nodes: columns.flat(),
    columns,
    links,
    scale,
  };
}
