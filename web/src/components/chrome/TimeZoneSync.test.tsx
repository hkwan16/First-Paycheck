import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markPageHydrated, resetPageHydration } from '@/lib/page-hydration';
import { db } from '@/test/msw/db';
import { apiUrl } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { act, renderWithProviders as render, waitFor } from '@/test/render';
import { TimeZoneSync } from './TimeZoneSync';

/** The browser's zone, as `Intl.DateTimeFormat().resolvedOptions()` reports it. */
function browserIn(zone: string) {
  const resolved = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
    this: Intl.DateTimeFormat,
  ) {
    return { ...resolved.call(this), timeZone: zone };
  });
}

/** The bodies of every `PUT /profile/time-zone` the component sends. */
function reports() {
  const sent: unknown[] = [];
  server.events.on('request:start', async ({ request }) => {
    if (request.method === 'PUT' && new URL(request.url).pathname === '/profile/time-zone') {
      sent.push(await request.clone().json());
    }
  });
  return sent;
}

/** Every read the component's page would make again. */
function profileReads() {
  let count = 0;
  server.events.on('request:start', ({ request }) => {
    if (request.method === 'GET' && new URL(request.url).pathname === '/profile') count += 1;
  });
  return () => count;
}

describe('TimeZoneSync (spec 019 rule 5)', () => {
  beforeEach(() => markPageHydrated());
  afterEach(() => {
    resetPageHydration();
    server.events.removeAllListeners();
    vi.restoreAllMocks();
  });

  it('saves the browser’s zone on the first page a person opens', async () => {
    browserIn('America/Los_Angeles');
    const sent = reports();
    render(<TimeZoneSync />);
    await waitFor(() => expect(sent).toEqual([{ time_zone: 'America/Los_Angeles' }]));
    expect(db.profile.time_zone).toBe('America/Los_Angeles');
  });

  it('saves a new zone when the browser moved, and nothing when it has not', async () => {
    db.profile.time_zone = 'America/New_York';
    browserIn('America/Chicago');
    const moved = reports();
    const first = render(<TimeZoneSync />);
    await waitFor(() => expect(moved).toEqual([{ time_zone: 'America/Chicago' }]));
    first.unmount();
    server.events.removeAllListeners();

    const reads = profileReads();
    const same = reports();
    render(<TimeZoneSync />);
    await waitFor(() => expect(reads()).toBe(1));
    // Give a report the chance to start: none does.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(same).toEqual([]);
  });

  it('waits for the page to hydrate, as the layout’s other readers do', async () => {
    resetPageHydration();
    browserIn('America/Denver');
    const sent = reports();
    const { queryClient } = render(<TimeZoneSync />);
    expect(queryClient.getQueryCache().getAll()).toEqual([]);
    act(() => markPageHydrated());
    await waitFor(() => expect(sent).toEqual([{ time_zone: 'America/Denver' }]));
  });

  it('tries a refused zone once per page load and logs why', async () => {
    browserIn('Mars/Olympus');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let attempts = 0;
    server.use(
      http.put(apiUrl('/profile/time-zone'), () => {
        attempts += 1;
        return HttpResponse.json(
          { error: { code: 'validation_error', message: 'Choose a time zone.' } },
          { status: 422 },
        );
      }),
    );
    const { queryClient } = render(<TimeZoneSync />);
    await waitFor(() => expect(attempts).toBe(1));
    await waitFor(() => expect(error).toHaveBeenCalledOnce());
    // The profile is read again (another screen's refetch): still one attempt.
    await act(() => queryClient.refetchQueries());
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(attempts).toBe(1);
    expect(db.profile.time_zone).toBeNull();
  });
});
