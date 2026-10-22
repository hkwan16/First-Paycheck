'use client';

import { usePathname } from 'next/navigation';
import { useCheckIns, useSetupProgress } from '@/lib/api/hooks';
import { usePageHydrated } from '@/lib/page-hydration';
import { checkInNavHref } from '@/lib/routes';
import { navKeyForPath, SideNav, type SideNavProps } from './SideNav';

type AppSideNavProps = Omit<SideNavProps, 'current'>;

/**
 * SideNav with `current` taken from the URL, done marks from API data
 * (setup-progress) and the monthly check-in linked to the newest open one.
 * The reads wait until the page has hydrated: the layout hydrates first, and
 * reads started here would reach the page's hooks before the page hydrates,
 * so its first render would not match its server HTML. Until then the
 * check-in item opens the list of check-ins.
 */
export function AppSideNav({ done, hrefs, ...props }: AppSideNavProps) {
  const current = navKeyForPath(usePathname());
  const pageHydrated = usePageHydrated();
  const withList = { checkIn: checkInNavHref(undefined), ...hrefs };
  if (done !== undefined || !pageHydrated) {
    return <SideNav {...props} hrefs={withList} done={done} current={current} />;
  }
  return <SideNavWithProgress {...props} hrefs={hrefs} current={current} />;
}

function SideNavWithProgress({ hrefs, ...props }: Omit<SideNavProps, 'done'>) {
  const progress = useSetupProgress();
  const checkIns = useCheckIns().data;
  return (
    <SideNav {...props} hrefs={{ checkIn: checkInNavHref(checkIns), ...hrefs }} done={progress} />
  );
}
