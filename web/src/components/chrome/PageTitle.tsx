import type { ReactNode } from 'react';

export interface PageTitleProps {
  title: ReactNode;
  lead?: ReactNode;
  /** Shown at the end of the title row, bottom-aligned (a count badge, a toggle, actions). */
  aside?: ReactNode;
  /** Shown above the title (a decision badge and date, for example). */
  eyebrow?: ReactNode;
}

/** The screen's h1 and lead, from the top block of every mockup screen. */
export function PageTitle({ title, lead, aside, eyebrow }: PageTitleProps) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow !== undefined && (
          <div className="mb-1.5 flex flex-wrap items-center gap-2">{eyebrow}</div>
        )}
        <h1 className="m-0">{title}</h1>
        {lead !== undefined && <p className="mt-1.5 mb-0 text-body text-ink-3">{lead}</p>}
      </div>
      {aside}
    </div>
  );
}
