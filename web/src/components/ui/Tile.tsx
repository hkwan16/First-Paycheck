import { createElement, type ComponentPropsWithoutRef } from 'react';
import { cn } from '@/lib/cn';
import { toneWash, type Hue } from '@/lib/design/tone';

type TileElement = 'div' | 'section';

export type TileProps<E extends TileElement = 'div'> = {
  as?: E;
  /** The hue of the decision the panel belongs to; neutral is the plain tile grey. */
  tone?: Hue;
} & Omit<ComponentPropsWithoutRef<E>, 'as'>;

/** From the mockup's `.result` and `.tile`: a recessed panel inside a card. */
export function Tile<E extends TileElement = 'div'>({
  as,
  tone = 'neutral',
  className,
  ...rest
}: TileProps<E>) {
  return createElement(as ?? 'div', {
    ...rest,
    className: cn('flex flex-col gap-2.5 rounded-tile p-4', toneWash[tone], className),
  });
}
