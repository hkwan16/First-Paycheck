'use client';

import { usePathname } from 'next/navigation';
import { useSetupProgress } from '@/lib/api/hooks';
import { navKeyForPath, SideNav, type SideNavProps } from './SideNav';

/** SideNav with `current` taken from the URL and done marks from API data (setup-progress). */
export function AppSideNav({ done, ...props }: Omit<SideNavProps, 'current'>) {
  const pathname = usePathname();
  const progress = useSetupProgress();
  return <SideNav {...props} done={done ?? progress} current={navKeyForPath(pathname)} />;
}
