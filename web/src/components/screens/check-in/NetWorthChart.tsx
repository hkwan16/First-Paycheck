'use client';

import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';
import { useContainerWidth } from '@/components/sankey';
import { Money } from '@/components/ui/Money';
import type { NetWorthPoint } from '@/lib/api/types';
import { cn } from '@/lib/cn';
import { toneMark } from '@/lib/design/tone';
import {
  formatAxisMoney,
  NET_WORTH_SERIES,
  netWorthChartData,
  type NetWorthRow,
} from './net-worth-chart';

const HEIGHT = 180;
const TICK = { fill: 'currentColor', fontSize: 12 };
/** End and hover dots: 8 px, in the series color, with a 2 px ring in the card's surface. */
const DOT = { r: 4, fill: 'currentColor', strokeWidth: 2, className: 'stroke-surface' };

interface TooltipProps {
  active?: boolean;
  payload?: readonly { payload?: NetWorthRow }[];
}

/** One readout for every series at the hovered month; values lead, line keys name them. */
function NetWorthTooltip({ active, payload }: TooltipProps) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div className="rounded-control bg-surface px-3 py-2 text-tiny shadow-pop">
      <div className="mb-1 font-semibold text-ink">{row.name}</div>
      {NET_WORTH_SERIES.map((series) => (
        <div key={series.key} className="flex items-center gap-2 text-ink-3">
          <span
            aria-hidden="true"
            className={cn('h-0.5 w-3 rounded-full bg-current', toneMark[series.tone])}
          />
          <Money cents={row[series.key]} className="font-semibold text-ink" />
          {series.label}
        </div>
      ))}
    </div>
  );
}

/**
 * Net worth, assets and liabilities by month (`GET /net-worth`'s series) as
 * three 2 px lines on one money axis, with an HTML legend, a crosshair
 * tooltip (pointer and keyboard, through Recharts' accessibility layer) and
 * no animation. The values are also in the card's monthly table.
 */
export function NetWorthChart({ series }: { series: readonly NetWorthPoint[] }) {
  const rows = netWorthChartData(series);
  const { ref, width } = useContainerWidth<HTMLDivElement>();
  const dot = rows.length === 1 ? DOT : false;

  return (
    <figure aria-label="Net worth by month" className="m-0 flex flex-col gap-2">
      <ul
        aria-label="Legend"
        className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-tiny"
      >
        {NET_WORTH_SERIES.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5 text-ink-2">
            <span
              aria-hidden="true"
              className={cn('h-0.5 w-3 rounded-full bg-current', toneMark[s.tone])}
            />
            {s.label}
          </li>
        ))}
      </ul>
      <div ref={ref} className="overflow-hidden text-ink-3">
        <LineChart
          width={width}
          height={HEIGHT}
          data={rows}
          margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
          accessibilityLayer
        >
          <CartesianGrid vertical={false} className="stroke-line" />
          <XAxis dataKey="tick" tickLine={false} axisLine={false} tick={TICK} />
          <YAxis
            width={56}
            allowDecimals={false}
            tickFormatter={formatAxisMoney}
            tickLine={false}
            axisLine={false}
            tick={TICK}
          />
          <Tooltip
            content={NetWorthTooltip}
            cursor={{ stroke: 'currentColor', strokeWidth: 1 }}
            isAnimationActive={false}
          />
          {NET_WORTH_SERIES.map((s) => (
            <Line
              key={s.key}
              dataKey={s.key}
              name={s.label}
              type="linear"
              className={toneMark[s.tone]}
              stroke="currentColor"
              strokeWidth={2}
              dot={dot}
              activeDot={DOT}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </div>
    </figure>
  );
}
