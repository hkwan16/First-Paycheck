import { cn } from '@/lib/cn';

export type SwatchColor =
  | 'blue'
  | 'coral'
  | 'teal'
  | 'plum'
  | 'ink-2'
  | 'flow-tax'
  | 'flow-idle'
  | 'blue-soft'
  | 'coral-soft';

const COLOR: Record<SwatchColor, string> = {
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
        dashed ? 'border-[1.5px] border-dashed border-flow-tax bg-transparent' : COLOR[color],
        className,
      )}
    />
  );
}
