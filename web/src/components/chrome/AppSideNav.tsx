'use client';

import { usePathname } from 'next/navigation';
import { navKeyForPath, SideNav, type SideNavProps } from './SideNav';

/** SideNav with `current` taken from the URL. */
export function AppSideNav(props: Omit<SideNavProps, 'current'>) {
  const pathname = usePathname();
  return <SideNav {...props} current={navKeyForPath(pathname)} />;
}
