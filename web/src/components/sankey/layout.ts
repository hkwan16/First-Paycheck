import type { CashFlow, FlowDiagramNode, SpendingBucket, WithholdingLine } from '@/lib/api/types';
import { categoryLabel } from '@/lib/categories';
import { isQuietFlow, type FlowColor } from '@/lib/design/tone';

/*
 * The cash-flow diagram's geometry, ported from the construction in
 * docs/mockup/Spending.dc.html: four columns of absolutely positioned HTML
 * nodes joined by one SVG of cubic bands.
 *
 *   0  gross pay            (the period's confirmed pay stubs)
 *   1  withholding lines, take-home, and the other money that came in
 *   2  where it went: buckets, left over (and take-home not deposited)
 *   3  each bucket's categories
 *
 * Every node and band is the API's (`GET /cashflow`'s `diagram`, spec 010
 * rule 5b), carried in cents and shown as is: the API balances them, so the
 * bands into and out of a node add up to its amount. This module only turns
 * cents into pixels: a node is as tall as its amount (or tall enough for its
 * words) and a band as thick as its cents, at one scale that puts the largest
 * node at a target height, so "1 px is about $N" is computed rather than
 * printed. Nothing it computes is ever shown as money except that scale.
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
/**
 * How tall the largest node is drawn; the scale follows from it. Small enough
 * that the diagram, its seven withholding lines and a dozen categories fit in
 * about one screen (issue 201).
 */
export const TARGET_GROSS_PX = 240;
/** The thinnest band drawn, so a few dollars still show. */
export const MIN_BAND_PX = 1.5;

export type FlowColumn = 0 | 1 | 2 | 3;

export type FlowNodeKind = FlowDiagramNode['kind'];

export interface FlowNode {
  /** The API's id: `gross`, `line:<key>`, `take_home`, `bucket:<b>`, `category:<c>`, ... */
  id: string;
  kind: FlowNodeKind;
  column: FlowColumn;
  name: string;
  /** The API's amount, untouched. */
  cents: number;
  color: FlowColor;
  /** Drawn dashed with no band: nothing flowed here. */
  zero: boolean;
  x: number;
  y: number;
  /** The node's height: its amount in pixels, at least MIN_NODE_H. */
  h: number;
  /** The node's amount in pixels (0 for a zero node). */
  valuePx: number;
  /** The withholding line, bucket or category the node stands for; null for the others. */
  key: string | null;
  /** A bucket: the money back in its categories that the summary nets out (API's). */
  refundsCents: number | null;
  /** Refunds and money taken out of savings: the categories behind the amount. */
  categories: readonly string[];
  /** What the node adds to the legend ("Taxes", "Essentials"); null for a category. */
  legend: string | null;
}

export interface FlowLink {
  id: string;
  from: string;
  to: string;
  /** The API's amount for the band. */
  cents: number;
  color: FlowColor;
  /** A grey band, drawn lighter. */
  quiet: boolean;
  /** As drawn: its cents in pixels, at least MIN_BAND_PX. */
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

type DrawnBucket = Exclude<SpendingBucket, 'income' | 'transfer'>;

interface Look {
  name: string;
  color: FlowColor;
  legend: string | null;
}

const BUCKETS: Record<DrawnBucket, Look & { categoryColor: FlowColor }> = {
  essentials: {
    name: 'Essentials',
    color: 'blue',
    categoryColor: 'blue-soft',
    legend: 'Essentials',
  },
  flexible: {
    name: 'Flexible',
    color: 'coral',
    categoryColor: 'coral-soft',
    legend: 'Flexible spending',
  },
  savings: { name: 'Savings', color: 'teal', categoryColor: 'teal', legend: 'Savings' },
  other: { name: 'Other', color: 'flow-tax', categoryColor: 'flow-tax', legend: 'Other spending' },
};

const LINE_LEGEND: Record<WithholdingLine['role'], string> = {
  tax: 'Taxes',
  retirement: '401(k)',
  health: 'Health premiums',
  other: 'Other deductions',
};

/** The nodes with fixed words and colors (spec 010 rule 5c); each is its own legend part. */
const FIXED: Partial<Record<FlowNodeKind, { name: string; color: FlowColor }>> = {
  take_home: { name: 'Take-home', color: 'ink-2' },
  income_deposited: { name: 'Income deposited', color: 'ink-2' },
  other_deposits: { name: 'Other deposits', color: 'ink-2' },
  refunds: { name: 'Refunds', color: 'ink-2' },
  savings_withdrawn: { name: 'Taken out of savings', color: 'teal' },
  beyond_income: { name: 'Spent beyond income', color: 'flow-idle' },
  not_deposited: { name: 'Not deposited', color: 'flow-idle' },
  left_over: { name: 'Left over', color: 'flow-idle' },
};

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

const isBucket = (key: string | null | undefined): key is DrawnBucket =>
  key != null && key in BUCKETS;

/** What a node is called, drawn in and adds to the legend. */
function describe(node: FlowDiagramNode, flow: CashFlow): Look {
  const fixed = FIXED[node.kind];
  if (fixed) return { ...fixed, legend: fixed.name };
  switch (node.kind) {
    case 'gross': {
      const stubs = flow.withholding.paycheck_count;
      return {
        // None paid in this period; the user may have one from another (spec 010 rule 5a).
        name:
          stubs > 0
            ? `Gross pay, ${stubs} ${plural(stubs, 'stub', 'stubs')}`
            : 'No pay stub this period',
        color: 'plum',
        legend: 'Gross pay',
      };
    }
    case 'line': {
      const line = flow.withholding.lines.find((l) => l.key === node.key);
      const label = line?.label ?? String(node.key);
      return {
        name: node.cents === 0 ? `${label}, not elected` : label,
        color: line ? LINE_COLOR[line.role] : 'flow-tax',
        legend: line ? LINE_LEGEND[line.role] : null,
      };
    }
    case 'bucket':
      return isBucket(node.key)
        ? BUCKETS[node.key]
        : { name: String(node.key), color: 'flow-tax', legend: null };
    default: {
      const bucket = flow.spending.category_buckets[String(node.key)];
      return {
        name: categoryLabel(String(node.key)),
        color: isBucket(bucket) ? BUCKETS[bucket].categoryColor : 'flow-tax',
        legend: null,
      };
    }
  }
}

/**
 * Whether the diagram draws a node: a $0 withholding line is left out unless
 * it is the 401(k) ("not elected"), and so is an empty Other bucket; every
 * other $0 node is drawn dashed.
 */
function drawn(node: FlowDiagramNode): boolean {
  if (node.cents > 0) return true;
  if (node.kind === 'line') return node.key === 'retirement_contribution';
  return !(node.kind === 'bucket' && node.key === 'other');
}

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

/**
 * Pixels per cent, from a target height for the largest node the API sent.
 * Picking the largest amount only sizes pixels; nothing is added and no amount
 * shown changes. Null when every node is $0.
 */
export function flowScale(flow: CashFlow): FlowScale | null {
  const reference = Math.max(0, ...flow.diagram.nodes.map((n) => n.cents));
  if (reference <= 0) return null;
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

  const scale = flowScale(flow);
  const px = (cents: number) => (scale && cents > 0 ? cents * scale.pxPerCent : 0);

  const columns: FlowLayout['columns'] = [[], [], [], []];
  for (const api of flow.diagram.nodes) {
    if (!drawn(api)) continue;
    const { name, color, legend } = describe(api, flow);
    const valuePx = px(api.cents);
    columns[api.column].push({
      id: api.id,
      kind: api.kind,
      column: api.column,
      key: api.key,
      name,
      cents: api.cents,
      color,
      zero: valuePx === 0,
      x: columnX[api.column],
      y: 0,
      h: Math.max(MIN_NODE_H, valuePx),
      valuePx,
      refundsCents: api.refunds_cents,
      categories: api.categories,
      legend,
    });
  }

  // Every column from the top, so the diagram is as tall as its tallest
  // column; the bands curve up to the buckets (spec 010 rule 5, issue 201).
  for (const column of columns) {
    let y = TOP;
    for (const node of column) {
      node.y = y;
      y += node.h + NODE_GAP;
    }
  }

  const nodes = columns.flat();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Where the next band along each node's right (out) and left (in) edge starts:
  // the node's amount is centred in it, and its bands fill that amount in order.
  const start = (node: FlowNode) => node.y + (node.h - node.valuePx) / 2;
  const outAt = new Map(nodes.map((n) => [n.id, start(n)]));
  const inAt = new Map(nodes.map((n) => [n.id, start(n)]));

  const links: FlowLink[] = [];
  for (const band of flow.diagram.links) {
    const from = byId.get(band.source);
    const to = byId.get(band.target);
    if (!from || !to) continue;
    const t = px(band.cents);
    const ya = outAt.get(from.id)!;
    const yb = inAt.get(to.id)!;
    outAt.set(from.id, ya + t);
    inAt.set(to.id, yb + t);
    // A band under the minimum is drawn thicker around its own slice.
    const thickness = Math.max(t, MIN_BAND_PX);
    const grow = (thickness - t) / 2;
    links.push({
      id: `${from.id}>${to.id}`,
      from: from.id,
      to: to.id,
      cents: band.cents,
      color: to.color,
      quiet: isQuietFlow(to.color),
      thickness,
      d: bandPath(from.x + NODE_W, ya - grow, to.x, yb - grow, thickness),
    });
  }

  const bottom = Math.max(...nodes.map((n) => n.y + n.h));
  return {
    hostW,
    hostH: Math.ceil(bottom) + BOTTOM,
    nodeW: NODE_W,
    columnX,
    nodes,
    columns,
    links,
    scale,
  };
}

/* ------------------------------------------------------------------ legend */

export interface LegendItem {
  color: FlowColor;
  label: string;
}

/** The legend's colors in the order it lists them. */
const LEGEND_ORDER: readonly FlowColor[] = [
  'plum',
  'flow-tax',
  'coral',
  'ink-2',
  'blue',
  'teal',
  'flow-idle',
];

/** "Taxes, other deductions and other spending": every part after the first lower case. */
function joinParts(parts: readonly string[]): string {
  const words = parts.map((part, i) =>
    i === 0 ? part : part.charAt(0).toLowerCase() + part.slice(1),
  );
  return words.length < 3
    ? words.join(' and ')
    : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/**
 * The legend for what the diagram draws with an amount (spec 010 rule 5c):
 * one item per color, naming each group drawn in it, so a period with no pay
 * stub lists no pay stub group.
 */
export function legendFor(layout: FlowLayout): LegendItem[] {
  const parts = new Map<FlowColor, string[]>();
  for (const node of layout.nodes) {
    if (node.zero || !node.legend) continue;
    const list = parts.get(node.color) ?? [];
    if (!list.includes(node.legend)) list.push(node.legend);
    parts.set(node.color, list);
  }
  return LEGEND_ORDER.filter((color) => parts.has(color)).map((color) => ({
    color,
    label: joinParts(parts.get(color)!),
  }));
}
