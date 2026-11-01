import type { ReactNode } from 'react';

export interface ShellProps {
  header: ReactNode;
  nav: ReactNode;
  children: ReactNode;
}

/**
 * From the mockup's `.shell`, `.nav` and `.main`: a wrapping row where the nav
 * takes 200-240px and the main column takes the rest; below 780px the nav
 * spans the full width above the content.
 */
export function Shell({ header, nav, children }: ShellProps) {
  return (
    <div className="min-h-screen">
      <a
        href="#main"
        className="sr-only z-20 rounded-control bg-surface px-4 py-2 font-semibold shadow-pop focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      {header}
      <div className="mx-auto flex w-full max-w-[1280px] flex-wrap gap-6 p-6">
        <div className="max-w-60 flex-[1_1_200px] max-nav:max-w-none">{nav}</div>
        <main id="main" className="flex min-w-0 flex-[999_1_560px] flex-col gap-6">
          {children}
        </main>
      </div>
    </div>
  );
}
