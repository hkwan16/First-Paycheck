import { Chip } from '@/components/ui/Chip';
import { cn } from '@/lib/cn';
import { Wordmark } from './Wordmark';

export interface HeaderProps {
  /** Context from the profile and user, e.g. "Acme Corp · Semi-monthly", "J. Rivera". */
  chips?: readonly string[];
  /** Wordmark only, for signed-out pages. */
  minimal?: boolean;
}

/**
 * From the mockup's `.top`: a translucent bar the content scrolls under.
 * Reduced transparency makes it solid.
 */
export function Header({ chips = [], minimal = false }: HeaderProps) {
  return (
    <header
      className={cn(
        'sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-line px-6 py-3',
        'bg-ground/72 backdrop-blur-[20px] backdrop-saturate-180',
        'reduce-transparency:bg-ground reduce-transparency:backdrop-blur-none reduce-transparency:backdrop-saturate-100',
      )}
    >
      <Wordmark />
      {!minimal && chips.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {chips.map((chip) => (
            <Chip key={chip}>{chip}</Chip>
          ))}
        </div>
      )}
    </header>
  );
}
