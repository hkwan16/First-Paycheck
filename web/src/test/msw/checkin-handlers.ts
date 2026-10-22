import { http, HttpResponse } from 'msw';
import { API_BASE_URL } from '@/lib/api/base-url';
import type { CheckInDetail, Holdings, NetWorth } from '@/lib/api/types';
import {
  checkInJob,
  checkInJobId,
  checkInJobResult,
  novemberCheckIn,
  octoberCheckIn,
  sampleHoldings,
  sampleNetWorth,
  summaryOf,
} from '../fixtures/checkins';
import { db } from './db';

/*
 * The M8 routes: `GET /check-ins`, `GET /check-ins/{id}`,
 * `PATCH /check-ins/{id}/findings/{fid}`, `GET /net-worth` and
 * `GET /holdings`, over their own in-memory state, reset after every test
 * (src/test/setup.ts), and `POST /check-ins` (M10, spec 015 rule 23). Its
 * jobs live in `db.jobs` with every other job, so `GET /jobs/{id}`
 * (handlers.ts) reads them: the n-th is `checkInJobId(n)`, and one nothing
 * scripted has already succeeded, having created the month's check-in (the
 * month of `checkinDb.now`), refreshed an open one or skipped a completed one.
 * `scriptJob(checkInJobStates(checkInJobId(1)))` before the request shows
 * queued, running and succeeded instead. `GET /calendar` with `from`/`to`
 * stays with the other calendar reads in handlers.ts (`db.calendar`).
 */

export interface CheckinDb {
  /** Every check-in with its findings, newest period first, as the list orders them. */
  checkIns: CheckInDetail[];
  netWorth: NetWorth;
  holdings: Holdings;
  /** The time a PATCH stamps on `user_action_at` and `completed_at`; its month is `POST /check-ins`'s. */
  now: string;
  /** `checkin.monthly` jobs `POST /check-ins` handed out, oldest first. */
  jobs: string[];
}

export const checkinDb: CheckinDb = {
  checkIns: [],
  netWorth: sampleNetWorth(),
  holdings: sampleHoldings(),
  now: '2026-11-16T18:00:00Z',
  jobs: [],
};

export function resetCheckinDb() {
  checkinDb.checkIns = [novemberCheckIn(), octoberCheckIn()];
  checkinDb.netWorth = sampleNetWorth();
  checkinDb.holdings = sampleHoldings();
  checkinDb.now = '2026-11-16T18:00:00Z';
  checkinDb.jobs = [];
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

/** The first day of the month `POST /check-ins` works on. */
const thisPeriod = () => `${checkinDb.now.slice(0, 7)}-01`;

/** This month's check-in, if there is one. */
const thisMonths = () => checkinDb.checkIns.find((c) => c.period === thisPeriod());

/**
 * What an unscripted job does at once (rule 8): create the month's check-in
 * (with November's findings), refresh an open one, or skip a completed one.
 */
function runCheckIn() {
  const existing = thisMonths();
  if (!existing) {
    const created = novemberCheckIn({ period: thisPeriod(), updated_at: checkinDb.now });
    checkinDb.checkIns.unshift(created);
    return { outcome: 'created' as const, check_in_id: created.id };
  }
  if (existing.status !== 'open') return { outcome: 'skipped' as const, check_in_id: existing.id };
  existing.updated_at = checkinDb.now;
  return { outcome: 'refreshed' as const, check_in_id: existing.id };
}

export const checkinHandlers = [
  http.get(apiUrl('/check-ins'), () => HttpResponse.json(checkinDb.checkIns.map(summaryOf))),

  // Rule 23: the month's job; while one is still queued, that job again.
  http.post(apiUrl('/check-ins'), () => {
    const checkInId = thisMonths()?.id ?? null;
    const latest = checkinDb.jobs.at(-1);
    if (latest !== undefined && db.jobs.get(latest)?.status === 'queued') {
      return HttpResponse.json({ job_id: latest, check_in_id: checkInId }, { status: 202 });
    }
    const id = checkInJobId(checkinDb.jobs.length + 1);
    checkinDb.jobs.push(id);
    if (!db.jobs.has(id)) {
      db.jobs.set(
        id,
        checkInJob(id, {
          status: 'succeeded',
          progress: 100,
          result: checkInJobResult(runCheckIn()),
          finished_at: checkinDb.now,
        }),
      );
    }
    return HttpResponse.json({ job_id: id, check_in_id: checkInId }, { status: 202 });
  }),

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
