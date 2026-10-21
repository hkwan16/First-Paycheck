import { http, HttpResponse } from 'msw';
import { API_BASE_URL } from '@/lib/api/base-url';
import type { CashFlow, RecurringCharge, RecurringPatch } from '@/lib/api/types';
import { sampleCashflow, sampleRecurring } from '../fixtures/cashflow';
import { SAMPLE_NOW } from '../fixtures/sample';

/*
 * The M5 routes: `GET /cashflow`, `GET /spending/summary`, `GET /recurring`
 * and `PATCH /recurring/{id}`, over their own in-memory state, reset after
 * every test (src/test/setup.ts). `POST /accounts/import` goes over
 * XMLHttpRequest like document uploads, so tests drive it with
 * `installFakeXhr()` instead of a handler here.
 */

export interface SpendingDb {
  /** What `GET /cashflow` answers; `spending` is also `GET /spending/summary`. */
  cashflow: CashFlow;
  recurring: RecurringCharge[];
}

export const spendingDb: SpendingDb = {
  cashflow: sampleCashflow(),
  recurring: structuredClone([...sampleRecurring]),
};

export function resetSpendingDb() {
  spendingDb.cashflow = sampleCashflow();
  spendingDb.recurring = structuredClone([...sampleRecurring]);
}

const apiUrl = (path: string) => `${API_BASE_URL}${path}`;

const invalid = (message: string) =>
  HttpResponse.json({ error: { code: 'validation_error', message } }, { status: 422 });

/**
 * The period of a `?start=&end=` read, as the API checks it (spec 007 part
 * B): both or neither, in order. Null with no period, a Response when invalid.
 */
function period(url: URL): { start: string; end: string } | null | Response {
  const start = url.searchParams.get('start');
  const end = url.searchParams.get('end');
  if ((start === null) !== (end === null)) return invalid('Give both start and end, or neither');
  if (start === null || end === null) return null;
  if (start > end) return invalid('start must not be after end');
  return { start, end };
}

/** The stored answer, for the period asked about (the sample numbers either way). */
function cashflowFor(url: URL): CashFlow | Response {
  const asked = period(url);
  if (asked instanceof Response) return asked;
  const flow = structuredClone(spendingDb.cashflow);
  if (asked) Object.assign(flow, asked, { spending: { ...flow.spending, ...asked } });
  return flow;
}

const PATCH_KEYS = new Set(['user_status', 'merchant_clean']);
const USER_STATUSES = new Set([null, 'confirmed', 'ignored', 'cancelled']);

export const spendingHandlers = [
  http.get(apiUrl('/cashflow'), ({ request }) => {
    const flow = cashflowFor(new URL(request.url));
    return flow instanceof Response ? flow : HttpResponse.json(flow);
  }),

  http.get(apiUrl('/spending/summary'), ({ request }) => {
    const flow = cashflowFor(new URL(request.url));
    return flow instanceof Response ? flow : HttpResponse.json(flow.spending);
  }),

  http.get(apiUrl('/recurring'), () => HttpResponse.json(spendingDb.recurring)),

  http.patch<{ id: string }, RecurringPatch>(
    apiUrl('/recurring/:id'),
    async ({ params, request }) => {
      const charge = spendingDb.recurring.find((c) => c.id === params.id);
      if (!charge) {
        return HttpResponse.json(
          { error: { code: 'not_found', message: 'Recurring charge not found' } },
          { status: 404 },
        );
      }
      const body = await request.json();
      const unknown = Object.keys(body).filter((key) => !PATCH_KEYS.has(key));
      if (unknown.length > 0) return invalid(`Unknown field: ${unknown.join(', ')}`);
      if ('user_status' in body) {
        if (!USER_STATUSES.has(body.user_status ?? null)) return invalid('Unknown user_status');
        charge.user_status = body.user_status ?? null;
      }
      if ('merchant_clean' in body && body.merchant_clean != null) {
        const name = body.merchant_clean.trim();
        if (name.length < 1 || name.length > 100) {
          return invalid('merchant_clean must be 1 to 100 characters');
        }
        charge.merchant_clean = name;
      }
      charge.updated_at = SAMPLE_NOW;
      return HttpResponse.json(charge);
    },
  ),
];
