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
   * `GET /plan` (spec 016): decisions, goals, the calendar and the newest pay
   * stub in one read, so whatever changes one of those changes it too.
   */
  plan: () => ['get', '/plan'] as const,

  /** Savings goals; a saved emergency fund decision creates or updates one. */
  goals: () => ['get', '/goals'] as const,
  /** Health plans from confirmed benefits summaries; a benefits confirm adds them. */
  benefitsPlans: () => ['get', '/benefits-plans'] as const,
};

/** The documents list and every document's detail (its own route, so not under the list's prefix). */
const documentReads = [queryKeys.documents(), queryKeys.document()];

const spendingReads = [queryKeys.transactions(), queryKeys.spendingSummary(), queryKeys.cashflow()];

/**
 * Balances and positions a sync writes (spec 015 rules 20 and 21), and the
 * goal progress read from them (on its own and in the plan).
 */
const balanceReads = [
  queryKeys.netWorth(),
  queryKeys.holdings(),
  queryKeys.goals(),
  queryKeys.plan(),
];

/** What each background job changes, so a finished job refreshes exactly those reads. */
export const JOB_INVALIDATES: Record<JobKind, readonly QueryKey[]> = {
  'sync.initial': [queryKeys.accounts(), ...spendingReads, ...balanceReads],
  'sync.incremental': [queryKeys.accounts(), ...spendingReads, ...balanceReads],
  'categorize.run': spendingReads,
  'ingest.extract': documentReads,
  // Detection writes the charges, then asks for a refresh of the month's open
  // check-in, whose findings name them (spec 015 rule 15, spec 017 rule 14).
  'recurring.detect': [queryKeys.recurring(), queryKeys.checkIns(), queryKeys.checkIn()],
  'checkin.monthly': [queryKeys.checkIns(), queryKeys.checkIn()],
  'schedule.tick': [],
  // The PDF is read by job id once the job succeeds; no cached read changes.
  'plan.export': [],
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

/** After a CSV import: a new account and its transactions are there. */
export const invalidateLinkedData = (client: QueryClient) =>
  invalidateAll(client, [queryKeys.accounts(), ...spendingReads]);

/**
 * After unlinking an institution (spec 017 rules 12-14): its accounts,
 * transactions, balances and holdings are gone, so every total built from
 * them changes, including a check-in's cash flow, and goal progress loses its
 * account. Recurring charges change only when the `recurring.detect` job the
 * unlink queued has run; `useUnlinkItem` follows that job, and its
 * `JOB_INVALIDATES` row reads the charges and check-ins again when it ends.
 */
export const invalidateAfterUnlink = (client: QueryClient) =>
  invalidateAll(client, [
    queryKeys.accounts(),
    ...spendingReads,
    ...balanceReads,
    queryKeys.checkIns(),
    queryKeys.checkIn(),
  ]);

/** After an upload or a queued extraction: statuses changed. */
export const invalidateDocuments = (client: QueryClient) => invalidateAll(client, documentReads);

/**
 * After a confirm: the document is confirmed, and a pay stub row exists or a
 * benefits summary's plans do (with its 401(k) match on the profile). The
 * plan shows the newest pay stub.
 */
export const invalidateAfterConfirm = (client: QueryClient) =>
  invalidateAll(client, [
    ...documentReads,
    queryKeys.payStubs(),
    queryKeys.benefitsPlans(),
    queryKeys.profile(),
    // The plan shows the newest confirmed pay stub.
    queryKeys.plan(),
  ]);

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
