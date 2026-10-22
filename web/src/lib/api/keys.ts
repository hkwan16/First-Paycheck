import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { operations } from './schema';
import type { JobKind } from './types';

/*
 * Query keys and invalidation. `$api.useQuery(method, path, init)` caches
 * under `[method, path, init?]`, so a two-element `[method, path]` key is a
 * prefix that matches every read of that route whatever its parameters.
 * Invalidate through these helpers rather than spelling keys at call sites.
 */

/** Filters for `GET /transactions`; the cursor is the page parameter, not a filter. */
export type TransactionFilters = Omit<
  NonNullable<operations['list_transactions']['parameters']['query']>,
  'cursor'
>;

export const queryKeys = {
  accounts: () => ['get', '/accounts'] as const,
  /** Prefix of every transactions read: pages, per-account counts. */
  transactions: () => ['get', '/transactions'] as const,
  /**
   * The paginated list. The trailing 'pages' keeps its InfiniteData apart
   * from a plain `$api.useQuery` read with the same filters.
   */
  transactionPages: (filters: TransactionFilters) =>
    ['get', '/transactions', { params: { query: filters } }, 'pages'] as const,
  job: (jobId: string) =>
    ['get', '/jobs/{job_id}', { params: { path: { job_id: jobId } } }] as const,

  documents: () => ['get', '/docs'] as const,
  /** One document's detail; without an id, the prefix of every document read. */
  document: (documentId?: string) =>
    documentId === undefined
      ? (['get', '/docs/{document_id}'] as const)
      : ([
          'get',
          '/docs/{document_id}',
          { params: { path: { document_id: documentId } } },
        ] as const),
  payStubs: () => ['get', '/pay-stubs'] as const,
  profile: () => ['get', '/profile'] as const,

  /**
   * A calculator result: `POST /calc/*` read as a query, cached per input
   * body. Without a body, the prefix of every result of that calculator.
   */
  calc: (path: string, body?: unknown) =>
    body === undefined ? (['post', path] as const) : (['post', path, { body }] as const),
  decisions: () => ['get', '/decisions'] as const,
  /** One decision version; without an id, the prefix of every version read. */
  decision: (decisionId?: string) =>
    decisionId === undefined
      ? (['get', '/decisions/{decision_id}'] as const)
      : ([
          'get',
          '/decisions/{decision_id}',
          { params: { path: { decision_id: decisionId } } },
        ] as const),
  explanation: (decisionId: string) =>
    [
      'get',
      '/decisions/{decision_id}/explanation',
      { params: { path: { decision_id: decisionId } } },
    ] as const,
  calendar: () => ['get', '/calendar'] as const,

  /** Prefixes of every period's read (hooks/spending.ts). */
  spendingSummary: () => ['get', '/spending/summary'] as const,
  cashflow: () => ['get', '/cashflow'] as const,
  recurring: () => ['get', '/recurring'] as const,

  /** Monthly check-ins (M8), newest first. */
  checkIns: () => ['get', '/check-ins'] as const,
  /** One check-in with its findings; without an id, the prefix of every check-in read. */
  checkIn: (checkInId?: string) =>
    checkInId === undefined
      ? (['get', '/check-ins/{check_in_id}'] as const)
      : ([
          'get',
          '/check-ins/{check_in_id}',
          { params: { path: { check_in_id: checkInId } } },
        ] as const),
  /** Prefix of every `GET /net-worth` read, whatever its `months`. */
  netWorth: () => ['get', '/net-worth'] as const,
  holdings: () => ['get', '/holdings'] as const,

  /**
   * The plan screen's read (M4); a saved decision changes it. The route does
   * not exist yet: the key is reserved so invalidation covers it when it lands.
   */
  plan: () => ['get', '/plan'] as const,
  /** Savings goals (M6); a saved emergency fund decision creates one. */
  goals: () => ['get', '/goals'] as const,
};

/** The documents list and every document's detail (its own route, so not under the list's prefix). */
const documentReads = [queryKeys.documents(), queryKeys.document()];

const spendingReads = [queryKeys.transactions(), queryKeys.spendingSummary(), queryKeys.cashflow()];

/** Balances and positions a sync writes (spec 015 rules 20 and 21). */
const balanceReads = [queryKeys.netWorth(), queryKeys.holdings()];

/** What each background job changes, so a finished job refreshes exactly those reads. */
export const JOB_INVALIDATES: Record<JobKind, readonly QueryKey[]> = {
  'sync.initial': [queryKeys.accounts(), ...spendingReads, ...balanceReads],
  'sync.incremental': [queryKeys.accounts(), ...spendingReads, ...balanceReads],
  'categorize.run': spendingReads,
  'ingest.extract': documentReads,
  'recurring.detect': [queryKeys.recurring()],
  'checkin.monthly': [queryKeys.checkIns(), queryKeys.checkIn()],
  'schedule.tick': [],
};

const invalidateAll = (client: QueryClient, keys: readonly QueryKey[]) =>
  Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey })));

export const invalidateForJob = (client: QueryClient, kind: JobKind) =>
  invalidateAll(client, JOB_INVALIDATES[kind]);

export const invalidateAccounts = (client: QueryClient) =>
  invalidateAll(client, [queryKeys.accounts()]);

/** After a category fix: the list, per-account reads and every total built from them. */
export const invalidateSpending = (client: QueryClient) => invalidateAll(client, spendingReads);

/** After a recurring charge is marked or renamed. */
export const invalidateRecurring = (client: QueryClient) =>
  invalidateAll(client, [queryKeys.recurring()]);

/**
 * After unlinking (the institution's accounts and transactions are gone) or
 * a CSV import (a new account and its transactions are there).
 */
export const invalidateLinkedData = (client: QueryClient) =>
  invalidateAll(client, [queryKeys.accounts(), ...spendingReads]);

/** After an upload or a queued extraction: statuses changed. */
export const invalidateDocuments = (client: QueryClient) => invalidateAll(client, documentReads);

/** After a confirm: the document is confirmed and a pay stub row exists. */
export const invalidateAfterConfirm = (client: QueryClient) =>
  invalidateAll(client, [...documentReads, queryKeys.payStubs()]);

/** The list and every version read (`is_current` changes when a version lands). */
const decisionReads = [queryKeys.decisions(), queryKeys.decision()];

/** A save lost a race (409): read the decisions again. */
export const invalidateDecisions = (client: QueryClient) => invalidateAll(client, decisionReads);

/**
 * After a saved decision: the decisions, and what a decision creates or
 * changes (spec 007 rule 14): calendar checks, the plan and goals.
 */
export const invalidateAfterDecision = (client: QueryClient) =>
  invalidateAll(client, [
    ...decisionReads,
    queryKeys.calendar(),
    queryKeys.plan(),
    queryKeys.goals(),
  ]);

/**
 * After a finding is marked done or dismissed, or undone: that check-in (its
 * counts and status change, spec 015 rule 13) and the list's counts.
 */
export const invalidateCheckIn = (client: QueryClient, checkInId: string) =>
  invalidateAll(client, [queryKeys.checkIn(checkInId), queryKeys.checkIns()]);
