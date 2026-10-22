import { useMutation, useQueryClient } from '@tanstack/react-query';
import { $api, fetchClient } from '../client';
import { apiErrorCode } from '../errors';
import { invalidateAfterConfirm, invalidateDocuments } from '../keys';
import type {
  BenefitsValues,
  Confirmed,
  DocumentStatus,
  DocumentSummary,
  DocumentType,
  PayStubValues,
} from '../types';
import { uploadDocument } from '../upload';
import { JOB_POLL_MS } from './jobs';
import { unwrap } from './request';

/** Statuses a person can review on the Confirm screen (`api/app/routers/docs.py` REVIEWABLE). */
const REVIEW_STATUSES: ReadonlySet<DocumentStatus> = new Set(['proposed', 'manual_entry_required']);

/**
 * A document waiting on the Confirm screen: a pay stub read and proposed or
 * needing every field typed, or a benefits summary read and proposed. A
 * benefits summary nothing could be read from is not typed in here: its plans
 * go in on the health plan card and its match in the 401(k) plan details.
 */
export const isReviewable = (document: Pick<DocumentSummary, 'type' | 'status'>) =>
  (document.type === 'pay_stub' && REVIEW_STATUSES.has(document.status)) ||
  (document.type === 'benefits' && document.status === 'proposed');

/**
 * The document Confirm opens from a `GET /docs` list (which is newest first):
 * the newest reviewable pay stub, since every calculator reads it, else the
 * newest reviewable benefits summary.
 */
export const newestReviewable = (documents: readonly DocumentSummary[] | undefined) =>
  documents?.find((d) => d.type === 'pay_stub' && isReviewable(d)) ?? documents?.find(isReviewable);

export interface UseDocumentsOptions {
  /**
   * Re-read every 1.5 s while a document is `extracting`, for documents
   * whose job this page did not start (after a reload, say). A function
   * picks which extracting documents count, so a screen already following a
   * document's job does not poll the list for it too.
   */
  pollWhileExtracting?: boolean | ((document: DocumentSummary) => boolean);
}

/** `GET /docs`: the person's documents, newest first. */
export function useDocuments({ pollWhileExtracting = false }: UseDocumentsOptions = {}) {
  const counts =
    typeof pollWhileExtracting === 'function' ? pollWhileExtracting : () => pollWhileExtracting;
  return $api.useQuery('get', '/docs', undefined, {
    refetchInterval: (query) =>
      query.state.data?.some((d) => d.status === 'extracting' && counts(d)) ? JOB_POLL_MS : false,
  });
}

/** `GET /docs/{id}`: one document and, while it is reviewable, its proposal. */
export function useDocument(documentId: string) {
  return $api.useQuery(
    'get',
    '/docs/{document_id}',
    { params: { path: { document_id: documentId } } },
    {
      // A 404 is an answer, not a blip.
      retry: false,
      refetchInterval: (query) => (query.state.data?.status === 'extracting' ? JOB_POLL_MS : false),
    },
  );
}

export interface UploadDocumentVariables {
  file: File;
  type: DocumentType;
  /** Whole percent sent, for a progress bar. */
  onProgress?: (percent: number) => void;
}

/**
 * `POST /docs` over XHR (upload.ts) so the bar moves while bytes leave. The
 * error is an `UploadError` with the status, code and Retry-After.
 */
export function useUploadDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: UploadDocumentVariables) => uploadDocument(variables),
    onSuccess: () => invalidateDocuments(queryClient),
  });
}

/**
 * `POST /docs/{id}/extract`: queue reading a document. Returns the job; pass
 * its id to `useJob`, whose `ingest.extract` kind refreshes the documents
 * when it finishes.
 */
export function useExtractDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) =>
      unwrap(
        fetchClient.POST('/docs/{document_id}/extract', {
          params: { path: { document_id: documentId } },
        }),
      ),
    onSettled: () => invalidateDocuments(queryClient),
  });
}

/** `details` of a 422 `pay_stub_unbalanced` (`api/calc/pay_stub.py` Balance). */
export interface PayStubBalance {
  gross_cents: number;
  deductions_cents: number;
  net_cents: number;
  /** Gross minus deductions. */
  expected_net_cents: number;
  /** Gross minus deductions minus net; zero when it balances. */
  difference_cents: number;
}

const BALANCE_KEYS = [
  'gross_cents',
  'deductions_cents',
  'net_cents',
  'expected_net_cents',
  'difference_cents',
] as const satisfies readonly (keyof PayStubBalance)[];

function readBalance(details: unknown): PayStubBalance | null {
  if (typeof details !== 'object' || details === null) return null;
  const record = details as Record<string, unknown>;
  if (!BALANCE_KEYS.every((key) => Number.isSafeInteger(record[key]))) return null;
  return Object.fromEntries(BALANCE_KEYS.map((key) => [key, record[key]])) as never;
}

interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> | null };
}

/**
 * The server's arithmetic gate refused the values: gross minus deductions is
 * not net. `balance` is the server's own diff, shown as it is; `error` keeps
 * the API body so `apiErrorMessage` reads it like any other error.
 */
export class PayStubUnbalanced extends Error {
  readonly error: ApiErrorBody['error'];
  readonly balance: PayStubBalance;

  constructor(body: ApiErrorBody, balance: PayStubBalance) {
    super(body.error.message);
    this.name = 'PayStubUnbalanced';
    this.error = body.error;
    this.balance = balance;
  }
}

/** Codes that mean the document changed state under the screen: re-read it. */
const STATE_CONFLICTS = new Set(['document_confirmed', 'document_deleted', 'document_not_ready']);

/** A pay stub's values, or a benefits summary's plans and match: the document's own type. */
export type ConfirmDocumentVariables =
  { documentId: string; values: PayStubValues } | { documentId: string; benefits: BenefitsValues };

export interface ConfirmDocumentOptions {
  /**
   * Called once the API has stored the values, before the reads refresh. It
   * belongs to the mutation, not to one `mutate` call: the refreshed document
   * can replace the reviewing component before the refresh finishes, and
   * TanStack drops a `mutate` call's callbacks once its component unmounts.
   */
  onConfirmed?: (confirmed: Confirmed) => void;
}

/**
 * `POST /docs/{id}/confirm` with the values the person checked. A 422
 * `pay_stub_unbalanced` is thrown as `PayStubUnbalanced`; anything else as
 * the API body. Success calls `onConfirmed`, then refreshes documents, pay
 * stubs, benefits plans and the profile (a benefits summary's match and
 * vesting are written to it).
 */
export function useConfirmDocument({ onConfirmed }: ConfirmDocumentOptions = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (variables: ConfirmDocumentVariables): Promise<Confirmed> => {
      const { data, error } = await fetchClient.POST('/docs/{document_id}/confirm', {
        params: { path: { document_id: variables.documentId } },
        body:
          'benefits' in variables
            ? { benefits: variables.benefits }
            : { pay_stub: variables.values },
      });
      if (error !== undefined) {
        const body = error as ApiErrorBody;
        const balance =
          apiErrorCode(body) === 'pay_stub_unbalanced' ? readBalance(body.error.details) : null;
        throw balance ? new PayStubUnbalanced(body, balance) : error;
      }
      return data;
    },
    onSuccess: (confirmed) => {
      onConfirmed?.(confirmed);
      return invalidateAfterConfirm(queryClient);
    },
    onError: (error) => {
      const code = apiErrorCode(error);
      if (code && STATE_CONFLICTS.has(code)) void invalidateDocuments(queryClient);
    },
  });
}
