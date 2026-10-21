import { cn } from '@/lib/cn';
import { flowBg, type FlowColor } from '@/lib/design/tone';

/** A swatch's color: one of the flow colors (lib/design/tone.ts). */
export type SwatchColor = FlowColor;

export interface SwatchProps {
  color?: SwatchColor;
  /** An empty dashed outline, for a node or legend entry worth $0. */
  dashed?: boolean;
  size?: 10 | 12;
  className?: string;
}

/** From the mockup's `.sw`: the color key in legends and Sankey nodes. Decorative. */
export function Swatch({ color = 'flow-tax', dashed = false, size = 10, className }: SwatchProps) {
  return (
    <i
      aria-hidden="true"
      className={cn(
        'inline-block flex-none rounded-[3px]',
        size === 10 ? 'size-2.5' : 'size-3',
        dashed ? 'border-[1.5px] border-dashed border-flow-tax bg-transparent' : flowBg[color],
        className,
      )}
    />
  );
}
