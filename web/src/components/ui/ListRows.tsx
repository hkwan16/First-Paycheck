import { createElement, type ComponentPropsWithoutRef } from 'react';
import { cn } from '@/lib/cn';

type ListElement = 'div' | 'ul' | 'ol';

export type ListRowsProps<E extends ListElement = 'div'> = {
  as?: E;
} & Omit<ComponentPropsWithoutRef<E>, 'as'>;

/** From the mockup's `.list`: rows separated by hairlines, flush top and bottom. */
export function ListRows<E extends ListElement = 'div'>({
  as,
  className,
  ...rest
}: ListRowsProps<E>) {
  return createElement(as ?? 'div', {
    ...rest,
    className: cn(
      'm-0 flex list-none flex-col p-0',
      '[&>*]:border-t [&>*]:border-line [&>*]:py-3.5',
      '[&>*:first-child]:border-t-0 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0',
      className,
    ),
  });
}
