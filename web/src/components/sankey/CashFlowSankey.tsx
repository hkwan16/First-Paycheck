'use client';

import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Money } from '@/components/ui/Money';
import { Swatch } from '@/components/ui/Swatch';
import type { CashFlow } from '@/lib/api/types';
import { cn } from '@/lib/cn';
import { flowFill, flowRing } from '@/lib/design/tone';
import { nextFocus } from './keyboard';
import {
  layoutCashFlow,
  placePopover,
  POPOVER_W,
  type FlowLayout,
  type FlowLink,
  type FlowNode,
} from './layout';
import { KEEP_ATTRIBUTE, useFlowPopover } from './useFlowPopover';

export const DEFAULT_HEADINGS = [
  'Pay stubs',
  'Withheld and deducted',
  'Take-home buckets',
  'Categories',
] as const;

export interface CashFlowSankeyProps {
  flow: CashFlow;
  /** The container's width; the diagram is never narrower than MIN_HOST_W and scrolls below it. */
  width: number;
  /** The four column headings. */
  headings?: readonly [string, string, string, string];
  /** What the popover says under a node's name and amount. */
  renderDetails?: (node: FlowNode) => ReactNode;
}

const keep = { [KEEP_ATTRIBUTE]: '' };

/** Band opacity at rest, and when a node is open (its own bands lit, the rest dimmed). */
function bandOpacity(link: FlowLink, open: string | null): number {
  const base = link.quiet ? 0.3 : 0.45;
  if (open === null) return base;
  const related = link.from === open || link.to === open;
  return related ? Math.min(0.85, base + 0.35) : base * 0.65;
}

/** A popover estimate until it is measured. */
const POPOVER_H_GUESS = 120;

function Popover({
  node,
  layout,
  id,
  renderDetails,
  props,
}: {
  node: FlowNode;
  layout: FlowLayout;
  id: string;
  renderDetails?: (node: FlowNode) => ReactNode;
  props: ReturnType<typeof useFlowPopover>['popoverProps'];
}) {
  const titleId = useId();
  const el = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(POPOVER_H_GUESS);
  useLayoutEffect(() => {
    const measured = el.current?.offsetHeight ?? 0;
    if (measured > 0) setHeight(measured);
  }, [node.id]);
  const place = placePopover(node, layout, height);
  const { ref, ...handlers } = props;

  return (
    <div
      id={id}
      role="group"
      aria-labelledby={titleId}
      ref={(element) => {
        el.current = element;
        ref(element);
      }}
      className={cn(
        'absolute z-30 flex flex-col gap-2 rounded-control bg-surface/95 px-3.5 py-3 text-ink shadow-pop backdrop-blur-lg backdrop-saturate-150',
        'animate-pop-in motion-reduce:animate-pop-fade reduce-transparency:bg-surface reduce-transparency:backdrop-blur-none',
        place.side === 'right' ? 'origin-top-left' : 'origin-top-right',
      )}
      style={{ left: place.left, top: place.top, width: POPOVER_W }}
      {...handlers}
    >
      <div className="flex flex-col gap-0.5">
        <div id={titleId} className="flex items-center gap-2 text-small font-semibold">
          <Swatch color={node.color} dashed={node.zero} size={10} />
          <span>{node.name}</span>
        </div>
        <Money cents={node.cents} className="text-headline font-bold" />
      </div>
      {renderDetails?.(node)}
    </div>
  );
}

/**
 * The cash-flow Sankey from docs/mockup/Spending.dc.html: absolutely
 * positioned node buttons over one SVG of bands. Hover, focus or a press
 * opens a node's popover (`useFlowPopover`); the nodes share one tab stop
 * and the arrow keys move between them (`nextFocus`).
 */
export function CashFlowSankey({
  flow,
  width,
  headings = DEFAULT_HEADINGS,
  renderDetails,
}: CashFlowSankeyProps) {
  const layout = useMemo(() => layoutCashFlow(flow, width), [flow, width]);
  const popoverId = useId();
  const hintId = useId();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const focusNode = useCallback((id: string) => buttons.current.get(id)?.focus(), []);
  const popover = useFlowPopover({ focusNode });

  // The roving tab stop: the last node focused, or the first.
  const [current, setCurrent] = useState<string | null>(null);
  const tabStop = layout.nodes.some((n) => n.id === current) ? current : layout.nodes[0]?.id;

  const openNode = layout.nodes.find((n) => n.id === popover.open) ?? null;

  const onKeyDown = (id: string) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = nextFocus(layout, id, event.key);
    if (next === null) return;
    event.preventDefault();
    setCurrent(next);
    focusNode(next);
  };

  return (
    <div className={cn(layout.hostW > width && 'overflow-x-auto')}>
      <div
        data-flow-host=""
        className="relative"
        style={{ width: layout.hostW, height: layout.hostH }}
      >
        <svg
          width={layout.hostW}
          height={layout.hostH}
          viewBox={`0 0 ${layout.hostW} ${layout.hostH}`}
          className="absolute top-0 left-0 overflow-visible"
          role="img"
          aria-label="Cash flow bands between the labeled amounts; every amount is written on its button."
        >
          {layout.links.map((link) => (
            <path
              key={link.id}
              d={link.d}
              className={cn(
                flowFill[link.color],
                'transition-[fill-opacity] duration-(--duration-fast) ease-out',
              )}
              fillOpacity={bandOpacity(link, popover.open)}
              {...keep}
              {...popover.bandProps(link.to)}
            />
          ))}
        </svg>

        {layout.columnX.map((x, column) => (
          <div
            key={column}
            aria-hidden="true"
            className="absolute top-0 text-micro font-semibold whitespace-nowrap text-ink-3 uppercase"
            style={{ left: x }}
          >
            {headings[column]}
          </div>
        ))}

        <p id={hintId} className="sr-only">
          Arrow keys move between amounts; each one opens its details.
        </p>

        {layout.nodes.map((node) => {
          const isOpen = node.id === popover.open;
          return (
            <button
              key={node.id}
              type="button"
              ref={(el) => {
                if (el) buttons.current.set(node.id, el);
                else buttons.current.delete(node.id);
              }}
              tabIndex={node.id === tabStop ? 0 : -1}
              aria-expanded={isOpen}
              aria-controls={isOpen ? popoverId : undefined}
              aria-describedby={hintId}
              className={cn(
                'absolute flex items-center gap-2 rounded-node border border-border bg-surface px-2.5 text-left text-code leading-[1.3] text-ink',
                'transition-shadow duration-(--duration-fast) ease-out',
                node.zero && 'border-dashed text-ink-3',
                isOpen &&
                  cn('z-20 ring-2', node.zero ? flowRing['flow-tax'] : flowRing[node.color]),
              )}
              style={{ left: node.x, top: node.y, width: layout.nodeW, height: node.h }}
              {...keep}
              {...popover.nodeProps(node.id)}
              onFocus={() => {
                setCurrent(node.id);
                popover.nodeProps(node.id).onFocus();
              }}
              onKeyDown={(event) => {
                popover.nodeProps(node.id).onKeyDown(event);
                if (!event.defaultPrevented) onKeyDown(node.id)(event);
              }}
            >
              <Swatch color={node.color} dashed={node.zero} size={12} />
              <span className="flex min-w-0 flex-col">
                <span className={cn('whitespace-nowrap', node.zero ? 'text-ink-3' : 'text-ink-2')}>
                  {node.name}
                </span>{' '}
                <Money cents={node.cents} className="font-bold whitespace-nowrap" />
              </span>
            </button>
          );
        })}

        {openNode && (
          <Popover
            key={openNode.id}
            node={openNode}
            layout={layout}
            id={popoverId}
            renderDetails={renderDetails}
            props={popover.popoverProps}
          />
        )}
      </div>
    </div>
  );
}
