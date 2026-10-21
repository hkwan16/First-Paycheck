import type { Route } from 'next';
import type { ReactNode } from 'react';
import { ArrowRightIcon } from '@/components/icons';
import { Button } from '@/components/ui/Button';

export interface StepFooterProps {
  back?: { href: Route; label?: string };
  next?: {
    label: string;
    href?: Route;
    onClick?: () => void;
    /** Primary (blue) by default. */
    primary?: boolean;
    /** Not ready yet: renders a real disabled button, never a dead link. */
    disabled?: boolean;
  };
  /** Text before the next button, e.g. "3 left to confirm". */
  status?: ReactNode;
}

/** The Back and continue row at the bottom of each setup screen. */
export function StepFooter({ back, next, status }: StepFooterProps) {
  const variant = next?.primary === false ? 'default' : 'primary';
  const nextContent = next && (
    <>
      {next.label}
      <ArrowRightIcon />
    </>
  );

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      {back ? <Button href={back.href}>{back.label ?? 'Back'}</Button> : <span />}
      <div className="flex flex-wrap items-center gap-3">
        {status !== undefined && <span className="text-small text-ink-3">{status}</span>}
        {next &&
          (next.href && !next.disabled ? (
            <Button href={next.href} variant={variant}>
              {nextContent}
            </Button>
          ) : (
            <Button variant={variant} disabled={next.disabled} onClick={next.onClick}>
              {nextContent}
            </Button>
          ))}
      </div>
    </div>
  );
}
