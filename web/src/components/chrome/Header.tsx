import type { ReactNode } from 'react';
import { Chip } from '@/components/ui/Chip';
import { cn } from '@/lib/cn';
import { Wordmark } from './Wordmark';

export interface HeaderProps {
  /** Context from the profile and user, e.g. "Acme Corp · Semi-monthly", "J. Rivera". */
  chips?: readonly string[];
  /**
   * The signed-in person's chips and menu, after the context chips. The (app)
   * layout passes it inside Suspense because it reads the session.
   */
  account?: ReactNode;
  /** Wordmark only, for signed-out pages. */
  minimal?: boolean;
}

/**
 * From the mockup's `.top`: a translucent bar the content scrolls under.
 * Reduced transparency makes it solid.
 */
export function Header({ chips = [], account, minimal = false }: HeaderProps) {
  return (
    <header
      className={cn(
        // min-h keeps the bar the same height with or without the chip row.
        'sticky top-0 z-10 flex min-h-[51px] items-center justify-between gap-4 border-b border-line px-6 py-3',
        'bg-ground/72 backdrop-blur-[20px] backdrop-saturate-180',
        'reduce-transparency:bg-ground reduce-transparency:backdrop-blur-none reduce-transparency:backdrop-saturate-100',
      )}
    >
      <Wordmark />
      {!minimal && (chips.length > 0 || account) && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {chips.map((chip) => (
            <Chip key={chip}>{chip}</Chip>
          ))}
          {account}
        </div>
      )}
    </header>
  );
}
