import { http, HttpResponse } from 'msw';
import { API_BASE_URL } from '@/lib/api/base-url';
import type {
  Account,
  AccountPatch,
  Category,
  CategoryFix,
  Job,
  LinkItemRequest,
  LinkedItem,
  Transaction,
} from '@/lib/api/types';
import { sampleJob, SAMPLE_SYNCED_AT } from '../fixtures/sample';
import { db } from './db';

export const apiUrl = (path: string) => `${API_BASE_URL}${path}`;

const notFound = (message: string) =>
  HttpResponse.json({ error: { code: 'not_found', message } }, { status: 404 });

const invalid = (message: string) =>
  HttpResponse.json({ error: { code: 'validation_error', message } }, { status: 422 });

let sequence = 0;
const nextId = (prefix: string) =>
  `${prefix}-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;

/**
 * Script the states `GET /jobs/{id}` returns, one per poll; the last state
 * repeats. `onSucceeded` runs once, when a succeeded state is first served
 * (an initial sync writing its accounts, for example).
 */
export function scriptJob(states: Job[], onSucceeded?: () => void) {
  const [first] = states;
  if (!first) throw new Error('scriptJob needs at least one state');
  jobScripts.set(first.id, { states: [...states], onSucceeded });
  db.jobs.set(first.id, first);
  return first.id;
}

const jobScripts = new Map<string, { states: Job[]; onSucceeded?: () => void }>();

/** The default progression for a new sync job: queued, running at 40%, succeeded. */
export function syncJobStates(id: string, kind: Job['kind'] = 'sync.initial'): Job[] {
  return [
    sampleJob({ id, kind, status: 'queued', progress: 0 }),
    sampleJob({ id, kind, status: 'running', progress: 40 }),
    sampleJob({
      id,
      kind,
      status: 'succeeded',
      progress: 100,
      result: { outcome: 'synced', accounts: 2, added: 12 },
      finished_at: SAMPLE_SYNCED_AT,
    }),
  ];
}

/** The accounts a sandbox First Platypus Bank link brings in. */
export function platypusAccounts(itemId: string): Account[] {
  return [
    {
      id: nextId('2b000000'),
      sync_item_id: itemId,
      institution_name: 'First Platypus Bank',
      name: 'Plaid Checking',
      kind: 'checking',
      mask: '0000',
      role: null,
      is_active: true,
      balance_cents: 11_000,
      balance_as_of: SAMPLE_SYNCED_AT,
    },
    {
      id: nextId('2b000000'),
      sync_item_id: itemId,
      institution_name: 'First Platypus Bank',
      name: 'Plaid Saving',
      kind: 'savings',
      mask: '1111',
      role: null,
      is_active: true,
      balance_cents: 21_000,
      balance_as_of: SAMPLE_SYNCED_AT,
    },
  ];
}

// Cursor: the offset of the next page, base64 encoded like the API's opaque cursors.
const encodeCursor = (offset: number) => btoa(String(offset));
const decodeCursor = (cursor: string) => Number(atob(cursor));

function listTransactions(url: URL) {
  const q = url.searchParams;
  const limit = Number(q.get('limit') ?? 50);
  const offset = q.get('cursor') ? decodeCursor(q.get('cursor')!) : 0;
  const rows = db.transactions.filter(
    (t) =>
      (!q.get('account_id') || t.account_id === q.get('account_id')) &&
      (!q.get('category') || t.category === q.get('category')) &&
      (!q.get('start') || t.posted_at >= q.get('start')!) &&
      (!q.get('end') || t.posted_at <= q.get('end')!),
  );
  const items = rows.slice(offset, offset + limit);
  const more = offset + limit < rows.length;
  return { items, next_cursor: more ? encodeCursor(offset + limit) : null };
}

/** Default handlers: the happy path for every route the web app calls. */
export const handlers = [
  http.get(apiUrl('/health'), () =>
    HttpResponse.json({ status: 'ok', git_sha: 'test', alembic_revision: '0001_roles' }),
  ),

  http.get(apiUrl('/accounts'), () => HttpResponse.json(db.accounts)),

  http.patch<{ id: string }, AccountPatch>(apiUrl('/accounts/:id'), async ({ params, request }) => {
    const account = db.accounts.find((a) => a.id === params.id);
    if (!account) return notFound('Account not found');
    const body = await request.json();
    if ('role' in body) {
      if (body.role === 'emergency_fund') {
        for (const other of db.accounts) {
          if (other.role === 'emergency_fund') other.role = null;
        }
      }
      account.role = body.role ?? null;
    }
    if ('is_active' in body) account.is_active = body.is_active;
    return HttpResponse.json(account);
  }),

  http.get(apiUrl('/transactions'), ({ request }) =>
    HttpResponse.json(listTransactions(new URL(request.url))),
  ),

  http.patch<{ id: string }, { category: Category }>(
    apiUrl('/transactions/:id'),
    async ({ params, request }) => {
      const txn = db.transactions.find((t) => t.id === params.id);
      if (!txn) return notFound('Transaction not found');
      const { category } = await request.json();
      Object.assign(txn, { category, category_source: 'user', confidence: null });
      const siblings = db.transactions.filter(
        (t: Transaction) =>
          t.id !== txn.id && t.merchant_norm === txn.merchant_norm && t.category_source !== 'user',
      );
      for (const sibling of siblings) {
        Object.assign(sibling, { category, category_source: 'rule', confidence: null });
      }
      const fix: CategoryFix = {
        transaction: txn,
        rule: { merchant_norm: txn.merchant_norm, category },
        relabeled: siblings.length,
      };
      return HttpResponse.json(fix);
    },
  ),

  http.post(apiUrl('/sync/link-token'), () =>
    HttpResponse.json({ link_token: 'link-sandbox-test', expiration: '2026-10-17T20:00:00Z' }),
  ),

  http.post<never, LinkItemRequest>(apiUrl('/sync/items'), async ({ request }) => {
    const body = await request.json();
    if (Boolean(body.public_token) === Boolean(body.sandbox_institution_id)) {
      return invalid('give exactly one of public_token or sandbox_institution_id');
    }
    const itemId = nextId('3c000000');
    const jobId = nextId('5a000000');
    const accounts = platypusAccounts(itemId);
    scriptJob(syncJobStates(jobId), () => db.accounts.push(...accounts));
    const linked: LinkedItem = {
      item: {
        id: itemId,
        provider: 'plaid',
        institution_name: body.institution_name ?? 'First Platypus Bank',
        status: 'active',
        last_synced_at: null,
        created_at: SAMPLE_SYNCED_AT,
      },
      job_id: jobId,
    };
    return HttpResponse.json(linked, { status: 201 });
  }),

  http.post<{ id: string }>(apiUrl('/sync/items/:id/sync'), ({ params }) => {
    if (!db.accounts.some((a) => a.sync_item_id === params.id)) {
      return notFound('Linked institution not found');
    }
    const jobId = scriptJob(syncJobStates(nextId('5a000000'), 'sync.incremental'));
    return HttpResponse.json({ job_id: jobId }, { status: 202 });
  }),

  http.delete<{ id: string }>(apiUrl('/sync/items/:id'), ({ params }) => {
    const gone = new Set(db.accounts.filter((a) => a.sync_item_id === params.id).map((a) => a.id));
    if (gone.size === 0) return notFound('Linked institution not found');
    db.accounts = db.accounts.filter((a) => !gone.has(a.id));
    db.transactions = db.transactions.filter((t) => !gone.has(t.account_id));
    return new HttpResponse(null, { status: 204 });
  }),

  http.get<{ id: string }>(apiUrl('/jobs/:id'), ({ params }) => {
    const script = jobScripts.get(params.id);
    if (script) {
      const [state] = script.states;
      if (script.states.length > 1) script.states.shift();
      else jobScripts.delete(params.id);
      if (state && state.status === 'succeeded' && script.onSucceeded) {
        script.onSucceeded();
        script.onSucceeded = undefined;
      }
      if (state) db.jobs.set(params.id, state);
    }
    const job = db.jobs.get(params.id);
    return job ? HttpResponse.json(job) : notFound('Job not found');
  }),
];

/** Forget scripted job states (called with resetDb after every test). */
export function resetJobScripts() {
  jobScripts.clear();
}
