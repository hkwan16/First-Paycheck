import { http, HttpResponse } from 'msw';
import { API_BASE_URL } from '@/lib/api/base-url';
import type { Plan } from '@/lib/api/types';
import {
  CALENDAR_FILENAME,
  exportJob,
  exportJobId,
  PLAN_PDF_FILENAME,
  sampleCalendarFile,
  samplePdfBytes,
  samplePlan,
} from '../fixtures/plan';
import { SAMPLE_NOW } from '../fixtures/sample';
import { db } from './db';

/*
 * The M9 routes (spec 016): `GET /plan`, `GET /plan/calendar.ics`,
 * `POST /plan/export` and `GET /plan/export/{job_id}`, over their own state,
 * reset after every test (src/test/setup.ts). Export jobs live in `db.jobs`
 * with every other job, so `GET /jobs/{id}` (handlers.ts) reads them and
 * `scriptJob(exportJobStates(exportJobId(1)))` scripts one before it is
 * started. An export nothing scripted has already succeeded.
 */

export interface PlanDb {
  plan: Plan;
  /** Export jobs handed out so far, oldest first. */
  exports: string[];
}

export const planDb: PlanDb = { plan: samplePlan(), exports: [] };

export function resetPlanDb() {
  planDb.plan = samplePlan();
  planDb.exports = [];
}

const apiUrl = (path: string) => `${API_BASE_URL}${path}`;

const notFound = (message: string) =>
  HttpResponse.json({ error: { code: 'not_found', message } }, { status: 404 });

export const planHandlers = [
  http.get(apiUrl('/plan'), () => HttpResponse.json(planDb.plan)),

  http.get(
    apiUrl('/plan/calendar.ics'),
    () =>
      new HttpResponse(sampleCalendarFile, {
        headers: {
          'Content-Type': 'text/calendar; charset=utf-8',
          'Content-Disposition': `attachment; filename="${CALENDAR_FILENAME}"`,
        },
      }),
  ),

  // Rule 9: a second export while one is still queued returns the same job.
  http.post(apiUrl('/plan/export'), () => {
    const latest = planDb.exports.at(-1);
    if (latest !== undefined && db.jobs.get(latest)?.status === 'queued') {
      return HttpResponse.json({ job_id: latest }, { status: 202 });
    }
    const id = exportJobId(planDb.exports.length + 1);
    planDb.exports.push(id);
    if (!db.jobs.has(id)) {
      db.jobs.set(
        id,
        exportJob(id, { status: 'succeeded', progress: 100, finished_at: SAMPLE_NOW }),
      );
    }
    return HttpResponse.json({ job_id: id }, { status: 202 });
  }),

  // Rule 16: only a succeeded export of this user's streams; anything else is 404.
  http.get<{ id: string }>(apiUrl('/plan/export/:id'), ({ params }) => {
    const job = db.jobs.get(params.id);
    if (!planDb.exports.includes(params.id) || job?.status !== 'succeeded') {
      return notFound('Export not found');
    }
    return new HttpResponse(samplePdfBytes(), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${PLAN_PDF_FILENAME}"`,
      },
    });
  }),
];
