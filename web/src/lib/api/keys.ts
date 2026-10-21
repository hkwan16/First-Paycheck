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

  // Routes that do not exist yet (see pending.ts). Their keys are reserved here
  // so job invalidation already covers them when they land.
  spendingSummary: () => ['get', '/spending/summary'] as const,
  cashflow: () => ['get', '/cashflow'] as const,
  recurring: () => ['get', '/recurring'] as const,
  checkIns: () => ['get', '/check-ins'] as const,
};

/** The documents list and every document's detail (its own route, so not under the list's prefix). */
const documentReads = [queryKeys.documents(), queryKeys.document()];

const spendingReads = [queryKeys.transactions(), queryKeys.spendingSummary(), queryKeys.cashflow()];

/** What each background job changes, so a finished job refreshes exactly those reads. */
export const JOB_INVALIDATES: Record<JobKind, readonly QueryKey[]> = {
  'sync.initial': [queryKeys.accounts(), ...spendingReads],
  'sync.incremental': [queryKeys.accounts(), ...spendingReads],
  'categorize.run': spendingReads,
  'ingest.extract': documentReads,
  'recurring.detect': [queryKeys.recurring()],
  'checkin.monthly': [queryKeys.checkIns()],
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

/** After unlinking: the institution's accounts and transactions are gone. */
export const invalidateLinkedData = (client: QueryClient) =>
  invalidateAll(client, [queryKeys.accounts(), ...spendingReads]);

/** After an upload or a queued extraction: statuses changed. */
export const invalidateDocuments = (client: QueryClient) => invalidateAll(client, documentReads);

/** After a confirm: the document is confirmed and a pay stub row exists. */
export const invalidateAfterConfirm = (client: QueryClient) =>
  invalidateAll(client, [...documentReads, queryKeys.payStubs()]);
