import { http, HttpResponse } from 'msw';
import { API_BASE_URL } from '@/lib/api/base-url';
import type { CheckInDetail, Holdings, NetWorth } from '@/lib/api/types';
import {
  novemberCheckIn,
  octoberCheckIn,
  sampleHoldings,
  sampleNetWorth,
  summaryOf,
} from '../fixtures/checkins';

/*
 * The M8 routes: `GET /check-ins`, `GET /check-ins/{id}`,
 * `PATCH /check-ins/{id}/findings/{fid}`, `GET /net-worth` and
 * `GET /holdings`, over their own in-memory state, reset after every test
 * (src/test/setup.ts). `GET /calendar` with `from`/`to` stays with the other
 * calendar reads in handlers.ts (`db.calendar`).
 */

export interface CheckinDb {
  /** Every check-in with its findings, newest period first, as the list orders them. */
  checkIns: CheckInDetail[];
  netWorth: NetWorth;
  holdings: Holdings;
  /** The time a PATCH stamps on `user_action_at` and `completed_at`. */
  now: string;
}

export const checkinDb: CheckinDb = {
  checkIns: [],
  netWorth: sampleNetWorth(),
  holdings: sampleHoldings(),
  now: '2026-11-16T18:00:00Z',
};

export function resetCheckinDb() {
  checkinDb.checkIns = [novemberCheckIn(), octoberCheckIn()];
  checkinDb.netWorth = sampleNetWorth();
  checkinDb.holdings = sampleHoldings();
  checkinDb.now = '2026-11-16T18:00:00Z';
}
resetCheckinDb();

const apiUrl = (path: string) => `${API_BASE_URL}${path}`;

const notFound = (message: string) =>
  HttpResponse.json({ error: { code: 'not_found', message } }, { status: 404 });

const invalid = (message: string) =>
  HttpResponse.json({ error: { code: 'validation_error', message } }, { status: 422 });

const ACTIONS = new Set(['done', 'dismissed', null]);

/** Spec 015 rule 13, as the API writes it after every PATCH. */
function settleStatus(checkIn: CheckInDetail, now: string) {
  checkIn.handled_count = checkIn.findings.filter((f) => f.user_action !== null).length;
  const complete = checkIn.findings.length > 0 && checkIn.handled_count === checkIn.findings.length;
  if (complete && checkIn.status !== 'completed') {
    checkIn.status = 'completed';
    checkIn.completed_at = now;
  } else if (!complete) {
    checkIn.status = 'open';
    checkIn.completed_at = null;
  }
}

export const checkinHandlers = [
  http.get(apiUrl('/check-ins'), () => HttpResponse.json(checkinDb.checkIns.map(summaryOf))),

  http.get<{ id: string }>(apiUrl('/check-ins/:id'), ({ params }) => {
    const checkIn = checkinDb.checkIns.find((c) => c.id === params.id);
    return checkIn ? HttpResponse.json(checkIn) : notFound('Check-in not found');
  }),

  http.patch<{ id: string; fid: string }, Record<string, unknown>>(
    apiUrl('/check-ins/:id/findings/:fid'),
    async ({ params, request }) => {
      const checkIn = checkinDb.checkIns.find((c) => c.id === params.id);
      const finding = checkIn?.findings.find((f) => f.id === params.fid);
      if (!checkIn || !finding) return notFound('Finding not found');
      const body = await request.json();
      const keys = Object.keys(body);
      if (keys.length !== 1 || keys[0] !== 'user_action') {
        return invalid('Send exactly one field, user_action');
      }
      const action = body.user_action;
      if (!ACTIONS.has(action as never)) return invalid('Unknown user_action');
      // Spec 015 rule 18: the same action again changes nothing.
      if (finding.user_action !== action) {
        finding.user_action = action as typeof finding.user_action;
        finding.user_action_at = action === null ? null : checkinDb.now;
        finding.updated_at = checkinDb.now;
      }
      settleStatus(checkIn, checkinDb.now);
      return HttpResponse.json(finding);
    },
  ),

  http.get(apiUrl('/net-worth'), ({ request }) => {
    const months = new URL(request.url).searchParams.get('months');
    if (months !== null && !/^\d+$/.test(months)) return invalid('months must be a whole number');
    if (months !== null && (Number(months) < 1 || Number(months) > 60)) {
      return invalid('months must be 1 to 60');
    }
    return HttpResponse.json(checkinDb.netWorth);
  }),

  http.get(apiUrl('/holdings'), () => HttpResponse.json(checkinDb.holdings)),
];
