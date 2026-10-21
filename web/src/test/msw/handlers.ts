import { http, HttpResponse } from 'msw';
import { API_BASE_URL } from '@/lib/api/base-url';
import type {
  Account,
  AccountPatch,
  Category,
  CategoryFix,
  ConfirmIn,
  Confirmed,
  DocumentDetail,
  DocumentSummary,
  DocumentType,
  Job,
  LinkItemRequest,
  LinkedItem,
  PayStubValues,
  ProfileIn,
  Transaction,
} from '@/lib/api/types';
import { samplePayStub } from '../fixtures/documents';
import { sampleJob, SAMPLE_NOW, SAMPLE_SYNCED_AT } from '../fixtures/sample';
import { db } from './db';

export const apiUrl = (path: string) => `${API_BASE_URL}${path}`;

const notFound = (message: string) =>
  HttpResponse.json({ error: { code: 'not_found', message } }, { status: 404 });

const invalid = (message: string) =>
  HttpResponse.json({ error: { code: 'validation_error', message } }, { status: 422 });

const appError = (status: number, code: string, message: string, details?: object) =>
  HttpResponse.json({ error: { code, message, ...(details ? { details } : {}) } }, { status });

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

/** An extraction: queued, running at 50%, succeeded (the proposal is written then). */
export function extractJobStates(id: string, documentId: string): Job[] {
  const job = (overrides: Partial<Job>) =>
    sampleJob({ id, kind: 'ingest.extract', created_at: SAMPLE_NOW, ...overrides });
  return [
    job({ status: 'queued', progress: 0 }),
    job({ status: 'running', progress: 50 }),
    job({
      status: 'succeeded',
      progress: 100,
      result: { document_id: documentId, status: 'proposed' },
      finished_at: SAMPLE_NOW,
    }),
  ];
}

/** Store a new upload the way `POST /docs` does: newest first, waiting to be read. */
export function createDocument(type: DocumentType): DocumentSummary {
  const document: DocumentSummary = {
    id: nextId('4d000000'),
    type,
    status: 'uploaded',
    status_reason: null,
    redaction_count: 0,
    page_count: null,
    uploaded_at: SAMPLE_NOW,
    confirmed_at: null,
    deleted_at: null,
  };
  db.documents.unshift(document);
  return document;
}

/** What the extraction job writes when it succeeds. */
function finishExtraction(documentId: string) {
  const document = db.documents.find((d) => d.id === documentId);
  if (!document || document.status !== 'extracting') return;
  const proposal = structuredClone(db.nextProposal);
  const filled = (proposal.fields ?? []).some((f) => f.value !== null);
  db.proposals.set(documentId, proposal);
  Object.assign(document, {
    status: filled ? 'proposed' : 'manual_entry_required',
    status_reason: filled ? null : 'refused',
    page_count: 1,
    redaction_count: (proposal.source_lines ?? []).filter((l) => l.redacted).length,
  });
}

const MONEY_KEYS = [
  'gross_cents',
  'federal_withholding_cents',
  'social_security_cents',
  'medicare_cents',
  'state_tax_cents',
  'retirement_contribution_cents',
  'medical_premium_cents',
  'other_deductions_cents',
  'net_cents',
] as const satisfies readonly (keyof PayStubValues)[];

/** `calc/pay_stub.py:balance`, so the handler answers 422 the way the API does. */
function balance(values: PayStubValues) {
  const [gross, ...rest] = MONEY_KEYS.map((key) => values[key]);
  const net = rest.pop()!;
  const deductions = rest.reduce((sum, cents) => sum + cents, 0);
  const expected = gross! - deductions;
  return {
    gross_cents: gross!,
    deductions_cents: deductions,
    net_cents: net,
    expected_net_cents: expected,
    difference_cents: expected - net,
  };
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

  http.get(apiUrl('/docs'), () => HttpResponse.json(db.documents)),

  http.post(apiUrl('/docs'), async ({ request }) => {
    const form = await request.formData();
    const type = form.get('type');
    const file = form.get('file');
    if (type !== 'pay_stub' && type !== 'benefits' && type !== 'offer_letter') {
      return invalid('type: Input should be pay_stub, offer_letter or benefits');
    }
    if (!(file instanceof File) || file.size === 0) {
      return appError(422, 'empty_file', 'The file is empty');
    }
    return HttpResponse.json({ document_id: createDocument(type).id }, { status: 201 });
  }),

  http.get<{ id: string }>(apiUrl('/docs/:id'), ({ params }) => {
    const document = db.documents.find((d) => d.id === params.id);
    if (!document) return notFound('Document not found');
    const reviewable =
      document.status === 'proposed' || document.status === 'manual_entry_required';
    const detail: DocumentDetail = {
      ...document,
      proposal: reviewable ? (db.proposals.get(document.id) ?? null) : null,
    };
    return HttpResponse.json(detail);
  }),

  http.post<{ id: string }>(apiUrl('/docs/:id/extract'), ({ params }) => {
    const document = db.documents.find((d) => d.id === params.id);
    if (!document) return notFound('Document not found');
    if (document.status === 'confirmed') {
      return appError(409, 'document_confirmed', 'This document is already confirmed');
    }
    if (document.type === 'offer_letter') {
      return appError(
        422,
        'extraction_unsupported',
        'offer_letter documents cannot be extracted yet',
      );
    }
    const jobId = scriptJob(extractJobStates(nextId('5a000000'), document.id), () =>
      finishExtraction(document.id),
    );
    Object.assign(document, { status: 'extracting', status_reason: null });
    return HttpResponse.json({ job_id: jobId }, { status: 202 });
  }),

  http.post<{ id: string }, ConfirmIn>(apiUrl('/docs/:id/confirm'), async ({ params, request }) => {
    const document = db.documents.find((d) => d.id === params.id);
    if (!document) return notFound('Document not found');
    if (document.status === 'confirmed') {
      return appError(409, 'document_confirmed', 'This document is already confirmed');
    }
    if (document.status !== 'proposed' && document.status !== 'manual_entry_required') {
      return appError(409, 'document_not_ready', 'This document has not been read yet');
    }
    const body = await request.json();
    const values = body.pay_stub;
    if (document.type !== 'pay_stub' || !values) {
      return appError(422, 'wrong_document_type', "Send this document's values under its type");
    }
    if (MONEY_KEYS.some((key) => !Number.isSafeInteger(values[key]))) {
      return invalid('body.pay_stub: every amount must be integer cents');
    }
    const result = balance(values);
    if (result.difference_cents !== 0) {
      return appError(
        422,
        'pay_stub_unbalanced',
        `Gross minus deductions is ${result.expected_net_cents} cents, but net is ${result.net_cents} cents`,
        result,
      );
    }
    const stub = samplePayStub({ ...values, id: nextId('6e000000'), document_id: document.id });
    db.payStubs.unshift(stub);
    db.proposals.delete(document.id);
    Object.assign(document, {
      status: 'confirmed',
      confirmed_at: SAMPLE_NOW,
      deleted_at: SAMPLE_NOW,
    });
    const confirmed: Confirmed = { document, pay_stub: stub, plans: [] };
    return HttpResponse.json(confirmed);
  }),

  http.get(apiUrl('/pay-stubs'), () => HttpResponse.json(db.payStubs)),

  http.get(apiUrl('/profile'), () => HttpResponse.json(db.profile)),

  http.put<never, ProfileIn>(apiUrl('/profile'), async ({ request }) => {
    const body = await request.json();
    db.profile = {
      dependents: body.dependents ?? 0,
      expected_healthcare_usage: body.expected_healthcare_usage ?? null,
      filing_status: body.filing_status ?? null,
      match_tiers: (body.match_tiers ?? []).map((tier) => ({
        employee_pct_upto: String(tier.employee_pct_upto),
        employer_pct: String(tier.employer_pct),
      })),
      other_jobs: body.other_jobs ?? [],
      pay_frequency: body.pay_frequency ?? null,
      salary_cents: body.salary_cents ?? null,
      start_date: body.start_date ?? null,
      updated_at: SAMPLE_NOW,
      vesting_years: body.vesting_years ?? null,
    };
    return HttpResponse.json(db.profile);
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
