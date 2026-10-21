import { cva } from 'class-variance-authority';
import type { Route } from 'next';
import Link from 'next/link';
import type { ComponentPropsWithRef, MouseEvent, ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** From the mockup's `.btn`, `.btn-primary`, `.btn-confirmed`, `.btn-sm`, `.btn-block`. */
export const buttonClasses = cva(
  [
    'relative inline-flex items-center justify-center gap-2 rounded-control border-0',
    'leading-[1.5] font-semibold whitespace-nowrap no-underline select-none',
    'transition-[scale,background-color] duration-(--duration-press) ease-out',
    // Feedback on press, not release. Reduced motion keeps the color change only.
    'active:scale-[.97] motion-reduce:active:scale-100',
    'disabled:cursor-not-allowed disabled:bg-fill disabled:text-ink-3 disabled:active:scale-100',
    'aria-disabled:cursor-progress aria-disabled:active:scale-100',
  ],
  {
    variants: {
      variant: {
        default: 'bg-fill text-ink hover:bg-fill-strong hover:text-ink',
        primary: 'bg-blue text-white hover:bg-blue-deep hover:text-white',
        confirmed:
          'bg-green-tint text-green-text hover:bg-[color-mix(in_srgb,var(--color-green)_8%,var(--color-green-tint))] hover:text-green-text',
      },
      size: {
        md: 'min-h-11 px-4 text-control',
        sm: 'min-h-9 px-3 text-small',
      },
      block: { true: 'w-full', false: '' },
    },
    defaultVariants: { variant: 'default', size: 'md', block: false },
  },
);

interface StyleProps {
  size?: 'md' | 'sm';
  block?: boolean;
  className?: string;
  children: ReactNode;
}

/** A toggle in the confirmed style must say whether it is pressed. */
type VariantProps =
  | { variant?: 'default' | 'primary'; pressed?: boolean }
  | { variant: 'confirmed'; pressed: boolean };

type NativeButtonProps = Omit<
  ComponentPropsWithRef<'button'>,
  'children' | 'className' | 'aria-pressed'
>;

export type ButtonAsButtonProps = StyleProps &
  VariantProps &
  NativeButtonProps & {
    href?: never;
    /** Shows a spinner, keeps the label (and so the width), and ignores clicks. */
    loading?: boolean;
  };

export type ButtonAsLinkProps = StyleProps &
  Omit<ComponentPropsWithRef<typeof Link>, 'href' | 'className' | 'children'> & {
    href: Route;
    variant?: 'default' | 'primary';
  };

export type ButtonProps = ButtonAsButtonProps | ButtonAsLinkProps;

function Spinner() {
  return (
    <span className="absolute inset-0 grid place-items-center" aria-hidden="true">
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        className="animate-spin motion-reduce:animate-pulse"
      >
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
        <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </span>
  );
}

export function Button(props: ButtonProps) {
  if (props.href !== undefined) {
    const { href, variant, size, block, className, children, ...rest } = props;
    return (
      <Link
        href={href}
        className={cn(buttonClasses({ variant, size, block }), className)}
        {...rest}
      >
        {children}
      </Link>
    );
  }

  const {
    variant,
    pressed,
    size,
    block,
    className,
    children,
    loading = false,
    type = 'button',
    onClick,
    ...rest
  } = props;

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (loading) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };

  return (
    <button
      type={type}
      aria-pressed={pressed}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      className={cn(buttonClasses({ variant, size, block }), className)}
      onClick={handleClick}
      {...rest}
    >
      <span className={cn('inline-flex items-center gap-2', loading && 'opacity-0')}>
        {children}
      </span>
      {loading && <Spinner />}
    </button>
  );
}
