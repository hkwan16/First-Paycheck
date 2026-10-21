/**
 * Color carries meaning, so components take a Tone instead of a color.
 *
 * - A Hue marks a kind of thing: blue for actions, AI-labeled items, W-4 and
 *   essentials; coral for the brand, health plan, flexible spending,
 *   redactions and citations; teal for savings and the emergency fund; plum
 *   for income, 401(k) and pay changes; neutral for everything else.
 * - A Status marks a state: confirmed (verified, saved, on plan), warning
 *   (needs a look, explanation fallback) and off (not applied, off plan).
 *
 * Green is reachable only as `confirmed`, amber only as `warning`, red only as
 * `off`. ESLint bans naming those colors anywhere outside src/components/ui
 * and this folder.
 *
 * Class strings are written out in full so Tailwind's scanner sees them.
 */

export const HUES = ['blue', 'coral', 'teal', 'plum', 'neutral'] as const;
export const STATUSES = ['confirmed', 'warning', 'off'] as const;
export const TONES = [...HUES, ...STATUSES] as const;

export type Hue = (typeof HUES)[number];
export type Status = (typeof STATUSES)[number];
export type Tone = Hue | Status;

export function isStatus(tone: Tone): tone is Status {
  return (STATUSES as readonly string[]).includes(tone);
}

/** Tint background with its darker text pair (badges, icon tiles, stat tiles). */
export const toneSoft: Record<Tone, string> = {
  blue: 'bg-blue-tint text-blue-text',
  coral: 'bg-coral-tint text-coral-text',
  teal: 'bg-teal-tint text-teal-text',
  plum: 'bg-plum-tint text-plum-text',
  neutral: 'bg-fill text-ink-2',
  confirmed: 'bg-green-tint text-green-text',
  warning: 'bg-amber-tint text-amber-text',
  off: 'bg-red-tint text-red-text',
};

/**
 * Solid background with white text. Where the hue itself is too light for
 * white text at 4.5:1 (coral, teal, amber), the darker text pair is the fill.
 */
export const toneSolid: Record<Tone, string> = {
  blue: 'bg-blue text-white',
  coral: 'bg-coral-text text-white',
  teal: 'bg-teal-text text-white',
  plum: 'bg-plum text-white',
  neutral: 'bg-ink-2 text-white',
  confirmed: 'bg-green text-white',
  warning: 'bg-amber-text text-white',
  off: 'bg-red text-white',
};

/** Text color for a value or headline set on a light background. */
export const toneText: Record<Tone, string> = {
  blue: 'text-blue-text',
  coral: 'text-coral-text',
  teal: 'text-teal-text',
  plum: 'text-plum-text',
  neutral: 'text-ink',
  confirmed: 'text-green-text',
  warning: 'text-amber-text',
  off: 'text-red-text',
};

/** Solid fill for marks: progress bars, swatches, tracks. */
export const toneFill: Record<Tone, string> = {
  blue: 'bg-blue',
  coral: 'bg-coral',
  teal: 'bg-teal',
  plum: 'bg-plum',
  neutral: 'bg-ink-3',
  confirmed: 'bg-green',
  warning: 'bg-amber',
  off: 'bg-red',
};

/** A lighter wash than the tint, for result panels that sit inside a card. */
export const toneWash: Record<Tone, string> = {
  blue: 'bg-blue-tint/60',
  coral: 'bg-coral-tint/60',
  teal: 'bg-teal-tint/50',
  plum: 'bg-plum-tint/60',
  neutral: 'bg-tile',
  confirmed: 'bg-green-tint/60',
  warning: 'bg-amber-tint/60',
  off: 'bg-red-tint/60',
};

/*
 * Flow colors: the cash-flow diagram's keys (components/sankey and the
 * legend swatches). Each is a token name; the hues keep their meanings
 * (plum pay and 401(k), blue essentials, coral health and flexible, teal
 * savings), the -soft shades mark a bucket's categories, and the greys are
 * quiet: ink-2 take-home, flow-tax taxes and other, flow-idle money not yet
 * spent. No status color is a flow color.
 */

export const FLOW_COLORS = [
  'blue',
  'coral',
  'teal',
  'plum',
  'ink-2',
  'flow-tax',
  'flow-idle',
  'blue-soft',
  'coral-soft',
] as const;

export type FlowColor = (typeof FLOW_COLORS)[number];

const QUIET_FLOWS: ReadonlySet<FlowColor> = new Set(['ink-2', 'flow-tax', 'flow-idle']);

/** Greys carry no meaning of their own, so their bands are drawn lighter. */
export const isQuietFlow = (color: FlowColor) => QUIET_FLOWS.has(color);

/** Background fill: swatches, Sankey node keys, stacked bar segments. */
export const flowBg: Record<FlowColor, string> = {
  blue: 'bg-blue',
  coral: 'bg-coral',
  teal: 'bg-teal',
  plum: 'bg-plum',
  'ink-2': 'bg-ink-2',
  'flow-tax': 'bg-flow-tax',
  'flow-idle': 'bg-flow-idle',
  'blue-soft': 'bg-blue-soft',
  'coral-soft': 'bg-coral-soft',
};

/** SVG fill for a Sankey band. */
export const flowFill: Record<FlowColor, string> = {
  blue: 'fill-blue',
  coral: 'fill-coral',
  teal: 'fill-teal',
  plum: 'fill-plum',
  'ink-2': 'fill-ink-2',
  'flow-tax': 'fill-flow-tax',
  'flow-idle': 'fill-flow-idle',
  'blue-soft': 'fill-blue-soft',
  'coral-soft': 'fill-coral-soft',
};

/** The ring around an open Sankey node. */
export const flowRing: Record<FlowColor, string> = {
  blue: 'ring-blue',
  coral: 'ring-coral',
  teal: 'ring-teal',
  plum: 'ring-plum',
  'ink-2': 'ring-ink-2',
  'flow-tax': 'ring-flow-tax',
  'flow-idle': 'ring-flow-idle',
  'blue-soft': 'ring-blue-soft',
  'coral-soft': 'ring-coral-soft',
};
