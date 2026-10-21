import type { Route } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { toneSoft, toneSolid, type Tone } from '@/lib/design/tone';

export interface BadgeProps {
  tone?: Tone;
  /** Solid fill with white text, for the one status that matters most on a screen. */
  solid?: boolean;
  icon?: ReactNode;
  href?: Route;
  className?: string;
  children: ReactNode;
  'aria-label'?: string;
  title?: string;
}

/** From the mockup's `.badge` and its `badge-*` tones. */
export function Badge({
  tone = 'neutral',
  solid = false,
  icon,
  href,
  className,
  children,
  ...rest
}: BadgeProps) {
  const classes = cn(
    'inline-flex items-center gap-[5px] rounded-full px-2 py-0.5 text-tiny leading-[1.5] font-semibold whitespace-nowrap no-underline',
    solid ? toneSolid[tone] : toneSoft[tone],
    href && 'hover:underline',
    className,
  );
  const content = (
    <>
      {icon}
      {children}
    </>
  );
  return href ? (
    <Link href={href} className={classes} {...rest}>
      {content}
    </Link>
  ) : (
    <span className={classes} {...rest}>
      {content}
    </span>
  );
}
