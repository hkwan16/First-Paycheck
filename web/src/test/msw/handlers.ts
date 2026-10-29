import { http, HttpResponse } from 'msw';
import { API_BASE_URL } from '@/lib/api/base-url';
import type {
  Account,
  AccountPatch,
  CalculatorDecisions,
  CalculatorKind,
  Category,
  CategoryFix,
  ConfirmIn,
  Confirmed,
  Decision,
  DecisionIn,
  DecisionSaved,
  DocumentDetail,
  DocumentSummary,
  DocumentType,
  ExplainIn,
  Explanation,
  Job,
  LinkItemRequest,
  LinkedItem,
  PayStubValues,
  ProfileIn,
  Transaction,
} from '@/lib/api/types';
import { deepEqual } from '@/lib/deep-equal';
import {
  k401Result,
  sampleCalendarEvent,
  sampleExplanation,
  sampleFallbackExplanation,
} from '../fixtures/decisions';
import { samplePayStub, sampleValues } from '../fixtures/documents';
import { sampleJob, SAMPLE_NOW, SAMPLE_SYNCED_AT } from '../fixtures/sample';
import { checkinHandlers } from './checkin-handlers';
import { db, emptyDb } from './db';
import {
  planningCalculators,
  planningHandlers,
  type DecisionCalculator,
  type DecisionEffects,
} from './planning-handlers';
import { planHandlers } from './plan-handlers';
import { spendingHandlers } from './spending-handlers';

export const apiUrl = (path: string) => `${API_BASE_URL}${path}`;

const notFound = (message: string) =>
  HttpResponse.json({ error: { code: 'not_found', message } }, { status: 404 });

const invalid = (message: string) =>
  HttpResponse.json({ error: { code: 'validation_error', message } }, { status: 422 });

/** A percentage as the API stores it (a two-place Decimal string): `4` and `"4"` are `"4.00"`. */
const storedPercent = (value: number | string) => Number(value).toFixed(2);

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

/** The n-th `recurring.detect` job an unlink queued (`DELETE /sync/items/{id}`). */
export const recurringJobId = (n: number) =>
  `5b000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * A recurring detection after an unlink: queued, running, succeeded with the
 * counts `run_detection` reports (one charge only the institution billed went).
 */
export function recurringJobStates(id: string): Job[] {
  const job = (overrides: Partial<Job>) =>
    sampleJob({ id, kind: 'recurring.detect', created_at: SAMPLE_NOW, ...overrides });
  return [
    job({ status: 'queued', progress: 0 }),
    job({ status: 'running', progress: 0 }),
    job({
      status: 'succeeded',
      progress: 100,
      result: { detected: 2, new: 0, changed: 0, stopped: 0, deleted: 1 },
      finished_at: SAMPLE_NOW,
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
    replaced_by_id: null,
  };
  db.documents.unshift(document);
  return document;
}

/**
 * Store an upload that replaces `documentId`, the way `POST /docs` with
 * `replaces` does (spec 004 rules 24-27): the new document leads the list, the
 * old one keeps its row, loses its file and proposal, and leaves `GET /docs`.
 */
export function replaceDocument(documentId: string): DocumentSummary {
  const old = db.documents.find((d) => d.id === documentId);
  if (!old) throw new Error(`No document ${documentId} to replace`);
  const created = createDocument(old.type);
  Object.assign(old, { replaced_by_id: created.id, deleted_at: old.deleted_at ?? SAMPLE_NOW });
  db.proposals.delete(old.id);
  return created;
}

const REPLACED = {
  code: 'document_replaced',
  message: 'This document was replaced by a newer upload',
};

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
      provider: 'plaid',
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
      provider: 'plaid',
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

/** `calculator_kind` order, which `GET /decisions` lists calculators in. */
const CALCULATOR_ORDER: readonly CalculatorKind[] = [
  'emergency_fund',
  'k401_match',
  'health_plans',
  'w4',
];

/** A decision as the API reads it: current when no other version supersedes it. */
const withCurrent = (decision: Decision): Decision => ({
  ...decision,
  is_current: !db.decisions.some((d) => d.supersedes_id === decision.id),
});

function listDecisions(): CalculatorDecisions[] {
  return CALCULATOR_ORDER.flatMap((calculator) => {
    const chain = db.decisions
      .filter((d) => d.calculator === calculator)
      .map(withCurrent)
      .sort((a, b) => b.version - a.version);
    const current = chain.find((d) => d.is_current);
    if (!current) return [];
    return [
      {
        calculator,
        current,
        versions: chain.map(({ id, version, supersedes_id, created_at }) => ({
          id,
          version,
          supersedes_id,
          created_at,
        })),
      },
    ];
  });
}

/** Spec 007 rule 14: a 401(k) decision schedules a check of the next pay stub. */
function k401Effects(decision: Decision): DecisionEffects {
  const event = sampleCalendarEvent({ id: nextId('ca000000'), decision_id: decision.id });
  db.calendar.push(event);
  return { calendar_event_id: event.id, goal_id: null };
}

/** Each saveable calculator's result (from its fixture) and what a saved version creates. */
const DECISION_CALCULATORS: Partial<Record<CalculatorKind, DecisionCalculator>> = {
  k401_match: { result: k401Result, effects: k401Effects },
  ...planningCalculators,
};

/**
 * `POST /decisions` (spec 007 rules 2, 4 and 5, and the side effects of rule
 * 14 and specs 011 and 012): the result must be the calculator's own (its
 * results fixture), and the version chain must not fork.
 */
async function saveDecision(request: Request) {
  const body = (await request.json()) as DecisionIn;
  const calculator = DECISION_CALCULATORS[body.calculator];
  if (!calculator) {
    return appError(422, 'calculator_unavailable', `${body.calculator} cannot be saved yet`);
  }
  const computed = calculator.result(body.inputs) as Record<string, unknown> | undefined;
  if (!computed) return invalid(`inputs: no ${body.calculator} results case for these inputs`);
  const refused = calculator.refuse?.(body.inputs);
  if (refused) return refused;
  const fields = Object.keys(computed).filter((key) => !deepEqual(computed[key], body.result[key]));
  if (fields.length > 0) {
    return appError(422, 'result_mismatch', "The result does not match the calculator's result", {
      fields,
    });
  }
  const conflict = () =>
    appError(
      409,
      'decision_conflict',
      'This decision has changed since you loaded it; reload and try again',
    );
  const chain = db.decisions.filter((d) => d.calculator === body.calculator);
  let version = 1;
  if (body.supersedes_id == null) {
    if (chain.length > 0) return conflict();
  } else {
    const parent = db.decisions.find((d) => d.id === body.supersedes_id);
    if (!parent) return notFound('Decision not found');
    if (parent.calculator !== body.calculator) {
      return appError(422, 'supersedes_mismatch', 'supersedes_id belongs to another calculator');
    }
    if (db.decisions.some((d) => d.supersedes_id === parent.id)) return conflict();
    version = parent.version + 1;
  }
  const decision: Decision = {
    id: nextId('dec00000'),
    calculator: body.calculator,
    version,
    supersedes_id: body.supersedes_id ?? null,
    check_in_id: null,
    inputs: body.inputs,
    result: { ...computed },
    created_at: SAMPLE_NOW,
    is_current: true,
  };
  const chainIds = new Set(chain.map((d) => d.id));
  for (const event of db.calendar) {
    if (event.decision_id && chainIds.has(event.decision_id) && event.status === 'upcoming') {
      event.status = 'dismissed';
    }
  }
  db.decisions.push(decision);
  const saved: DecisionSaved = {
    decision_id: decision.id,
    calculator: decision.calculator,
    version,
    supersedes_id: decision.supersedes_id,
    created_at: decision.created_at,
    ...calculator.effects(decision),
  };
  return HttpResponse.json(saved, { status: 201 });
}

/** The rows one explain run writes (spec 008 rules 15 and 16). */
function explainRun(decisionId: string): Explanation[] {
  const outcome = db.explainOutcomes.shift() ?? 'verified';
  const row = (overrides: Partial<Explanation>) =>
    sampleExplanation({ id: nextId('e0000000'), decision_id: decisionId, ...overrides });
  if (outcome === 'verified') return [row({})];
  const failed = { verified: false, prompt_version: 'explain/v1' };
  return [
    row({ ...failed, attempt: 1, retries: 0 }),
    row({ ...failed, attempt: 2, retries: 1 }),
    sampleFallbackExplanation({ id: nextId('e0000000'), decision_id: decisionId }),
  ];
}

async function explain(request: Request) {
  const { decision_id: decisionId, force = false } = (await request.json()) as ExplainIn;
  if (!db.decisions.some((d) => d.id === decisionId)) return notFound('Decision not found');
  const rows = db.explanations.get(decisionId) ?? [];
  const verified = rows.filter((r) => r.verified).at(-1);
  if (!force && verified) return HttpResponse.json(verified);
  if (!db.llmConfigured) {
    return appError(503, 'llm_unavailable', 'Explanations are not available right now');
  }
  const run = explainRun(decisionId);
  db.explanations.set(decisionId, [...rows, ...run]);
  return HttpResponse.json(run.at(-1));
}

/** Default handlers: the happy path for every route the web app calls. */
export const handlers = [
  // First: its benefits confirm handler passes pay stubs on to the one below.
  ...planningHandlers,

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
    const account = db.accounts.find((a) => a.sync_item_id === params.id);
    if (!account) return notFound('Linked institution not found');
    if (account.provider !== 'plaid') {
      // Spec 002 rule 29: an imported account's data arrives only by import.
      return appError(
        422,
        'not_plaid_item',
        'Only a linked institution can sync; import a new CSV file instead',
      );
    }
    const jobId = scriptJob(syncJobStates(nextId('5a000000'), 'sync.incremental'));
    return HttpResponse.json({ job_id: jobId }, { status: 202 });
  }),

  http.delete<{ id: string }>(apiUrl('/sync/items/:id'), ({ params }) => {
    const gone = new Set(db.accounts.filter((a) => a.sync_item_id === params.id).map((a) => a.id));
    if (gone.size === 0) return notFound('Linked institution not found');
    db.accounts = db.accounts.filter((a) => !gone.has(a.id));
    db.transactions = db.transactions.filter((t) => !gone.has(t.account_id));
    // The recurring.detect job it queued for what is left, or the one still
    // waiting (spec 017 rule 11). Unless a test scripted it, it has already
    // succeeded by the first poll.
    const last = db.recurringJobs.at(-1);
    if (last !== undefined && db.jobs.get(last)?.status === 'queued') {
      return HttpResponse.json({ recurring_job_id: last });
    }
    const jobId = recurringJobId(db.recurringJobs.length + 1);
    db.recurringJobs.push(jobId);
    const succeeded = recurringJobStates(jobId).at(-1);
    if (succeeded && !db.jobs.has(jobId)) db.jobs.set(jobId, succeeded);
    return HttpResponse.json({ recurring_job_id: jobId });
  }),

  http.get(apiUrl('/docs'), () =>
    HttpResponse.json(db.documents.filter((d) => d.replaced_by_id === null)),
  ),

  http.post(apiUrl('/docs'), async ({ request }) => {
    const form = await request.formData();
    const type = form.get('type');
    const file = form.get('file');
    const replaces = form.get('replaces');
    if (type !== 'pay_stub' && type !== 'benefits' && type !== 'offer_letter') {
      return invalid('type: Input should be pay_stub, offer_letter or benefits');
    }
    if (replaces !== null) {
      const old = db.documents.find((d) => d.id === replaces);
      if (!old) return notFound('Document not found');
      if (old.replaced_by_id !== null) return appError(409, REPLACED.code, REPLACED.message);
      if (old.type !== type) {
        return appError(
          422,
          'replace_type_mismatch',
          `A ${type} upload cannot replace a ${old.type} document`,
        );
      }
    }
    if (!(file instanceof File) || file.size === 0) {
      return appError(422, 'empty_file', 'The file is empty');
    }
    const created = typeof replaces === 'string' ? replaceDocument(replaces) : createDocument(type);
    return HttpResponse.json({ document_id: created.id }, { status: 201 });
  }),

  http.get<{ id: string }>(apiUrl('/docs/:id'), ({ params }) => {
    const document = db.documents.find((d) => d.id === params.id);
    if (!document) return notFound('Document not found');
    const reviewable =
      document.replaced_by_id === null &&
      (document.status === 'proposed' || document.status === 'manual_entry_required');
    const detail: DocumentDetail = {
      ...document,
      proposal: reviewable ? (db.proposals.get(document.id) ?? null) : null,
    };
    return HttpResponse.json(detail);
  }),

  http.post<{ id: string }>(apiUrl('/docs/:id/extract'), ({ params }) => {
    const document = db.documents.find((d) => d.id === params.id);
    if (!document) return notFound('Document not found');
    if (document.replaced_by_id !== null) return appError(409, REPLACED.code, REPLACED.message);
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
    if (document.replaced_by_id !== null) return appError(409, REPLACED.code, REPLACED.message);
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
    // The yearly salary is the API's figure (spec 005 rule 24a); the fake knows
    // it only for the sample stub's gross and frequency, never works one out.
    const sampleSalary =
      values.gross_cents === sampleValues.gross_cents &&
      values.pay_frequency === sampleValues.pay_frequency;
    const stub = samplePayStub({
      ...values,
      id: nextId('6e000000'),
      document_id: document.id,
      ...(sampleSalary ? {} : { annual_salary_cents: null }),
    });
    db.payStubs.unshift(stub);
    db.proposals.delete(document.id);
    Object.assign(document, {
      status: 'confirmed',
      confirmed_at: SAMPLE_NOW,
      deleted_at: SAMPLE_NOW,
    });
    const confirmed: Confirmed = { document, pay_stub: stub, plans: [], profile_updated: false };
    return HttpResponse.json(confirmed);
  }),

  http.get(apiUrl('/pay-stubs'), () => HttpResponse.json(db.payStubs)),

  http.get(apiUrl('/profile'), () => HttpResponse.json(db.profile)),

  // Spec 017: every row the user owns goes with the account; a repeat is 204 too.
  http.delete(apiUrl('/me'), () => {
    emptyDb();
    return new HttpResponse(null, { status: 204 });
  }),

  http.put<never, ProfileIn>(apiUrl('/profile'), async ({ request }) => {
    const body = await request.json();
    db.profile = {
      birth_year: body.birth_year ?? null,
      dependents: body.dependents ?? 0,
      expected_healthcare_usage: body.expected_healthcare_usage ?? null,
      filing_status: body.filing_status ?? null,
      match_tiers: (body.match_tiers ?? []).map((tier) => ({
        employee_pct_upto: storedPercent(tier.employee_pct_upto),
        employer_pct: storedPercent(tier.employer_pct),
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

  // The calculator itself: answers from the API's own results (k401-results.json).
  http.post(apiUrl('/calc/401k-match'), async ({ request }) => {
    const inputs: unknown = await request.json();
    const result = k401Result(inputs);
    if (!result) {
      return appError(
        500,
        'test_fixture_missing',
        'k401-results.json has no case for these inputs',
        {
          inputs,
        },
      );
    }
    return HttpResponse.json(result);
  }),

  http.get(apiUrl('/decisions'), () => HttpResponse.json({ items: listDecisions() })),

  http.post(apiUrl('/decisions'), ({ request }) => saveDecision(request)),

  http.get<{ id: string }>(apiUrl('/decisions/:id'), ({ params }) => {
    const decision = db.decisions.find((d) => d.id === params.id);
    return decision ? HttpResponse.json(withCurrent(decision)) : notFound('Decision not found');
  }),

  http.get<{ id: string }>(apiUrl('/decisions/:id/explanation'), ({ params }) => {
    if (!db.decisions.some((d) => d.id === params.id)) return notFound('Decision not found');
    const latest = db.explanations.get(params.id)?.at(-1);
    return latest ? HttpResponse.json(latest) : notFound('This decision has no explanation yet');
  }),

  http.post(apiUrl('/explain'), ({ request }) => explain(request)),

  // Spec 015 rule 22: `from` and `to` bound `due_at`, each on its own.
  http.get(apiUrl('/calendar'), ({ request }) => {
    const query = new URL(request.url).searchParams;
    const from = query.get('from');
    const to = query.get('to');
    if (from !== null && to !== null && from > to) return invalid('from must not be after to');
    return HttpResponse.json(
      db.calendar
        .filter((event) => event.status === 'upcoming')
        .filter(
          (event) => (from === null || event.due_at >= from) && (to === null || event.due_at <= to),
        )
        .sort((a, b) => a.due_at.localeCompare(b.due_at)),
    );
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

  ...spendingHandlers,
  ...checkinHandlers,
  ...planHandlers,
];

/** Forget scripted job states (called with resetDb after every test). */
export function resetJobScripts() {
  jobScripts.clear();
}
