'use client';

import { usePathname } from 'next/navigation';
import { useSetupProgress } from '@/lib/api/hooks';
import { usePageHydrated } from '@/lib/page-hydration';
import { navKeyForPath, SideNav, type SideNavProps } from './SideNav';

type AppSideNavProps = Omit<SideNavProps, 'current'>;

/**
 * SideNav with `current` taken from the URL and done marks from API data
 * (setup-progress). The marks wait until the page has hydrated: the layout
 * hydrates first, and reads started here would reach the page's hooks before
 * the page hydrates, so its first render would not match its server HTML.
 */
export function AppSideNav({ done, ...props }: AppSideNavProps) {
  const current = navKeyForPath(usePathname());
  const pageHydrated = usePageHydrated();
  if (done !== undefined || !pageHydrated) {
    return <SideNav {...props} done={done} current={current} />;
  }
  return <SideNavWithProgress {...props} current={current} />;
}

function SideNavWithProgress(props: Omit<SideNavProps, 'done'>) {
  const progress = useSetupProgress();
  return <SideNav {...props} done={progress} />;
}
