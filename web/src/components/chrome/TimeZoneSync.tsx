'use client';

import { useEffect, useRef } from 'react';
import { useProfile, useSaveTimeZone } from '@/lib/api/hooks';
import { logErrorOnce } from '@/lib/log-error';
import { usePageHydrated } from '@/lib/page-hydration';

/**
 * Keeps the profile's time zone the browser's (spec 019 rule 5): the API
 * dates everything by the person's day in that zone, and the browser is the
 * one place that knows where the person is. Renders nothing.
 *
 * It waits for the page to hydrate, as the layout's other readers do (see
 * `usePageHydrated`), then compares `GET /profile`'s `time_zone` with
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` and saves the browser's
 * when they differ. Each zone is tried at most once per page load, so a zone
 * the API refuses is logged once and not sent again on every profile read.
 */
export function TimeZoneSync() {
  return usePageHydrated() ? <SyncTimeZone /> : null;
}

function SyncTimeZone() {
  const saved = useProfile().data?.time_zone;
  const loaded = saved !== undefined;
  const { mutate } = useSaveTimeZone();
  const tried = useRef(new Set<string>());

  useEffect(() => {
    if (!loaded) return;
    const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!browser || browser === saved || tried.current.has(browser)) return;
    tried.current.add(browser);
    mutate(browser, {
      onError: (error) => logErrorOnce('Could not save the time zone', error),
    });
  }, [loaded, saved, mutate]);

  return null;
}
