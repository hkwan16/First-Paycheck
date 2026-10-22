import type { ComponentPropsWithRef, ReactNode } from 'react';
import { AlertIcon, CheckIcon, ShieldCheckIcon } from '@/components/icons';
import { cn } from '@/lib/cn';

type NoticeTone = 'blue' | 'confirmed' | 'warning';

export interface NoticeProps extends Omit<ComponentPropsWithRef<'div'>, 'title'> {
  tone?: NoticeTone;
  /** Bold lead-in sentence. */
  title?: ReactNode;
  /** Replaces the default icon; null removes it. */
  icon?: ReactNode | null;
  /** Tighter padding and radius, for inline results such as "The math checks out." */
  compact?: boolean;
}

const TONE: Record<NoticeTone, string> = {
  blue: 'bg-blue-tint text-ink',
  confirmed: 'bg-green-tint text-green-text',
  warning: 'bg-amber-tint text-amber-text',
};

const DEFAULT_ICON: Record<NoticeTone, ReactNode> = {
  blue: <ShieldCheckIcon size={20} className="text-blue-text" />,
  confirmed: <CheckIcon size={16} strokeWidth={1.8 * (12 / 16)} />,
  warning: <AlertIcon size={16} />,
};

/** From the mockup's `.notice` and the inline confirmed and warning result rows. */
export function Notice({
  tone = 'blue',
  title,
  icon,
  compact = false,
  className,
  children,
  ...rest
}: NoticeProps) {
  const glyph = icon === undefined ? DEFAULT_ICON[tone] : icon;
  return (
    <div
      className={cn(
        'flex items-start text-small',
        compact ? 'gap-3 rounded-control px-3.5 py-3' : 'gap-3 rounded-tile px-4 py-3.5',
        TONE[tone],
        className,
      )}
      {...rest}
    >
      {glyph !== null && <span className="mt-0.5 flex flex-none">{glyph}</span>}
      <div className="min-w-0">
        {title !== undefined && (
          <>
            <strong>{title}</strong>{' '}
          </>
        )}
        {children}
      </div>
    </div>
  );
}
