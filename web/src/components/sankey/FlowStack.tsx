'use client';

import { useMemo } from 'react';
import { ListRows } from '@/components/ui/ListRows';
import { Money } from '@/components/ui/Money';
import { Swatch } from '@/components/ui/Swatch';
import type { CashFlow } from '@/lib/api/types';
import { cn } from '@/lib/cn';
import { flowBg } from '@/lib/design/tone';
import { layoutCashFlow, MIN_HOST_W, type FlowLayout, type FlowNode } from './layout';

/** Below this container width the diagram becomes stacked bars. */
export const STACK_BELOW = 640;

interface Stage {
  id: string;
  title: string;
  /** The node the stage starts from, whose amount heads it; null when several do. */
  source: FlowNode | null;
  items: FlowNode[];
}

/**
 * The diagram's stages for a narrow screen: gross pay into its lines and
 * take-home; the money that came in into where it went (one stage headed by
 * take-home or the deposits when they were all of it, else one list for each
 * side); then each bucket into its categories. The same nodes and amounts as
 * the Sankey.
 */
function stages(layout: FlowLayout): Stage[] {
  const [[gross], column1, uses] = layout.columns;
  const lines = column1.filter((n) => n.kind === 'line' || n.kind === 'take_home');
  const sources = column1.filter((n) => n.kind !== 'line');
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const result: Stage[] = [];
  if (gross && !gross.zero) {
    result.push({ id: gross.id, title: gross.name, source: gross, items: lines });
  }
  const [only] = sources;
  if (sources.length === 1 && only) {
    result.push({ id: only.id, title: only.name, source: only, items: uses });
  } else {
    result.push({
      id: 'sources',
      title: 'Where the money came from',
      source: null,
      items: sources,
    });
    result.push({ id: 'uses', title: 'Where it went', source: null, items: uses });
  }
  for (const bucket of uses) {
    const items = layout.links
      .filter((l) => l.from === bucket.id)
      .map((l) => byId.get(l.to))
      .filter((n): n is FlowNode => n !== undefined);
    if (items.length > 0) result.push({ id: bucket.id, title: bucket.name, source: bucket, items });
  }
  return result;
}

/**
 * The cash-flow diagram under 640 px: one section per stage, each with a
 * decorative stacked bar and the list of amounts it shows. The bar's
 * segments grow by the API's cents (CSS flex-grow), so the browser sizes
 * them and nothing is computed here.
 */
export function FlowStack({ flow }: { flow: CashFlow }) {
  const layout = useMemo(() => layoutCashFlow(flow, MIN_HOST_W), [flow]);
  return (
    <div className="flex flex-col gap-5">
      {stages(layout).map(({ id, title, source, items }) => (
        <section key={id} aria-label={title} className="flex flex-col gap-2">
          <h3 className="m-0 flex items-baseline justify-between gap-3 text-small">
            <span>{title}</span>
            {source && <Money cents={source.cents} className="font-bold" />}
          </h3>
          <div
            aria-hidden="true"
            data-flow-bar={id}
            className="flex h-2.5 gap-px overflow-hidden rounded-full bg-line"
          >
            {items
              .filter((item) => !item.zero)
              .map((item) => (
                <span
                  key={item.id}
                  className={cn('h-full min-w-px', flowBg[item.color])}
                  style={{ flexGrow: item.cents, flexBasis: 0 }}
                />
              ))}
          </div>
          <ListRows as="ul" className="[&>*]:py-1.5">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex items-center justify-between gap-3 text-small text-ink-2"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Swatch color={item.color} dashed={item.zero} />
                  <span className={cn(item.zero && 'text-ink-3')}>{item.name}</span>
                </span>
                <Money cents={item.cents} className="font-semibold text-ink" />
              </li>
            ))}
          </ListRows>
        </section>
      ))}
    </div>
  );
}
