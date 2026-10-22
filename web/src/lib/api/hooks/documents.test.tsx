import { act, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFakeXhr } from '@/test/fake-xhr';
import {
  BENEFITS_DOC_ID,
  PAY_STUB_DOC_ID,
  sampleBenefitsDocument,
  sampleDocument,
  sampleProposal,
  sampleValues,
} from '@/test/fixtures/documents';
import { sampleBenefitsValues } from '@/test/fixtures/planning';
import { db, emptyDocuments } from '@/test/msw/db';
import { apiUrl, createDocument } from '@/test/msw/handlers';
import { benefitsWaiting } from '@/test/msw/planning-handlers';
import { server } from '@/test/msw/server';
import { renderHookWithClient } from '@/test/render';
import { apiErrorMessage } from '../errors';
import { queryKeys } from '../keys';
import {
  isReviewable,
  newestReviewable,
  PayStubUnbalanced,
  useConfirmDocument,
  useDocument,
  useDocuments,
  useExtractDocument,
  useUploadDocument,
} from './documents';
import { JOB_POLL_MS, useJob } from './jobs';

const countRequests = (path: string) => {
  const seen = { count: 0 };
  server.events.on('request:start', ({ request }) => {
    if (new URL(request.url).pathname === path) seen.count += 1;
  });
  return seen;
};

afterEach(() => {
  server.events.removeAllListeners();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useDocuments', () => {
  it('reads the documents, newest first', async () => {
    db.documents = [sampleDocument(), sampleBenefitsDocument];
    const { result } = renderHookWithClient(() => useDocuments());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((d) => d.id)).toEqual([PAY_STUB_DOC_ID, BENEFITS_DOC_ID]);
  });

  it('polls while asked to and a document is being read, and stops when it is done', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    db.documents = [sampleDocument({ status: 'extracting', redaction_count: 0 })];
    const requests = countRequests('/docs');
    const { result } = renderHookWithClient(() => useDocuments({ pollWhileExtracting: true }));
    await waitFor(() => expect(result.current.data?.[0]?.status).toBe('extracting'));
    db.documents = [sampleDocument()];
    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
    await waitFor(() => expect(result.current.data?.[0]?.status).toBe('proposed'));
    const settled = requests.count;
    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS * 3));
    expect(requests.count).toBe(settled);
  });

  it('polls only for extracting documents the predicate picks', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    db.documents = [sampleDocument({ status: 'extracting' })];
    const requests = countRequests('/docs');
    const tracked = new Set([PAY_STUB_DOC_ID]);
    const { result } = renderHookWithClient(() =>
      useDocuments({ pollWhileExtracting: (d) => !tracked.has(d.id) }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS * 3));
    expect(requests.count).toBe(1);
  });

  it('does not poll unless asked', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    db.documents = [sampleDocument({ status: 'extracting' })];
    const requests = countRequests('/docs');
    const { result } = renderHookWithClient(() => useDocuments());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS * 3));
    expect(requests.count).toBe(1);
  });
});

describe('newestReviewable', () => {
  it('picks the newest pay stub waiting for review or manual entry', () => {
    const older = sampleDocument({ id: 'older' });
    const manual = sampleDocument({ id: 'manual', status: 'manual_entry_required' });
    expect(newestReviewable([manual, older])?.id).toBe('manual');
    expect(
      newestReviewable([sampleBenefitsDocument, sampleDocument({ status: 'confirmed' }), older])
        ?.id,
    ).toBe('older');
    expect(newestReviewable([sampleDocument({ status: 'extracting' })])).toBeUndefined();
    expect(newestReviewable(undefined)).toBeUndefined();
  });

  it('picks a benefits summary waiting for review when no pay stub is', () => {
    expect(
      newestReviewable([sampleBenefitsDocument, sampleDocument({ status: 'confirmed' })])?.id,
    ).toBe(BENEFITS_DOC_ID);
  });

  it('isReviewable needs a pay stub that was read or needs typing, or a benefits summary that was read', () => {
    expect(isReviewable(sampleDocument())).toBe(true);
    expect(isReviewable(sampleDocument({ status: 'manual_entry_required' }))).toBe(true);
    expect(isReviewable(sampleBenefitsDocument)).toBe(true);
    // Plans that could not be read are entered on the health plan card, not typed here.
    expect(isReviewable({ ...sampleBenefitsDocument, status: 'manual_entry_required' })).toBe(
      false,
    );
    expect(isReviewable({ ...sampleBenefitsDocument, type: 'offer_letter' })).toBe(false);
    expect(isReviewable(sampleDocument({ status: 'failed' }))).toBe(false);
  });
});

describe('useDocument', () => {
  it('reads one document with its proposal', async () => {
    const { result } = renderHookWithClient(() => useDocument(PAY_STUB_DOC_ID));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.proposal?.fields).toEqual(sampleProposal.fields);
    expect(result.current.data?.redaction_count).toBe(2);
  });

  it('polls while the document is being read', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    db.documents = [sampleDocument({ status: 'extracting' })];
    const { result } = renderHookWithClient(() => useDocument(PAY_STUB_DOC_ID));
    await waitFor(() => expect(result.current.data?.status).toBe('extracting'));
    expect(result.current.data?.proposal).toBeNull();
    db.documents = [sampleDocument()];
    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
    await waitFor(() => expect(result.current.data?.status).toBe('proposed'));
  });

  it("surfaces a missing document as the API's 404", async () => {
    const { result } = renderHookWithClient(() => useDocument('nope'));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(apiErrorMessage(result.current.error, 'x')).toBe('Document not found');
  });
});

describe('useUploadDocument', () => {
  it('uploads with progress and refreshes the documents list', async () => {
    const xhr = installFakeXhr();
    emptyDocuments();
    const progress: number[] = [];
    const { result, queryClient } = renderHookWithClient(() => ({
      docs: useDocuments(),
      upload: useUploadDocument(),
    }));
    await waitFor(() => expect(result.current.docs.data).toEqual([]));

    const file = new File(['%PDF-1.7'], 'acme.pdf', { type: 'application/pdf' });
    let created: Promise<unknown> = Promise.resolve();
    act(() => {
      created = result.current.upload.mutateAsync({
        file,
        type: 'pay_stub',
        onProgress: (p) => progress.push(p),
      });
    });
    await waitFor(() => expect(xhr.requests).toHaveLength(1));
    xhr.last().progress(50, 100);
    const document = createDocument('pay_stub');
    xhr.last().respond(201, { document_id: document.id });
    await expect(created).resolves.toEqual({ document_id: document.id });
    expect(progress).toEqual([50]);
    await waitFor(() => expect(result.current.docs.data?.[0]?.id).toBe(document.id));
    expect(queryClient.getQueryState(queryKeys.documents())?.isInvalidated).toBe(false);
  });
});

describe('useExtractDocument', () => {
  it('queues the extraction, and the job it returns refreshes the document when done', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const document = createDocument('pay_stub');
    const { result } = renderHookWithClient(() => {
      const extract = useExtractDocument();
      const job = useJob(extract.data?.job_id);
      const detail = useDocument(document.id);
      return { extract, job, detail };
    });
    await waitFor(() => expect(result.current.detail.data?.status).toBe('uploaded'));

    act(() => result.current.extract.mutate(document.id));
    await waitFor(() => expect(result.current.job.data?.status).toBe('queued'));
    expect(result.current.job.data?.kind).toBe('ingest.extract');
    await waitFor(() => expect(result.current.detail.data?.status).toBe('extracting'));

    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
    await waitFor(() => expect(result.current.job.data?.progress).toBe(50));
    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
    await waitFor(() => expect(result.current.detail.data?.status).toBe('proposed'));
    expect(result.current.detail.data?.proposal?.fields).toHaveLength(14);
    expect(result.current.detail.data?.redaction_count).toBe(2);
  });

  it("reports the API's refusal for a type it cannot read", async () => {
    const document = createDocument('offer_letter');
    const { result } = renderHookWithClient(() => useExtractDocument());
    act(() => result.current.mutate(document.id));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(apiErrorMessage(result.current.error, 'x')).toBe(
      'offer_letter documents cannot be extracted yet',
    );
  });
});

describe('useConfirmDocument', () => {
  it('confirms, then refreshes documents and pay stubs', async () => {
    const { result, queryClient } = renderHookWithClient(() => useConfirmDocument());
    queryClient.setQueryData(queryKeys.payStubs(), []);
    queryClient.setQueryData(queryKeys.documents(), []);
    act(() => result.current.mutate({ documentId: PAY_STUB_DOC_ID, values: sampleValues }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.document.status).toBe('confirmed');
    expect(result.current.data?.pay_stub?.net_cents).toBe(199_604);
    expect(db.payStubs).toHaveLength(1);
    expect(queryClient.getQueryState(queryKeys.payStubs())?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(queryKeys.documents())?.isInvalidated).toBe(true);
  });

  it("throws the server's arithmetic diff as a typed error", async () => {
    const { result } = renderHookWithClient(() => useConfirmDocument());
    act(() =>
      result.current.mutate({
        documentId: PAY_STUB_DOC_ID,
        values: { ...sampleValues, net_cents: 199_606 },
      }),
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    const error = result.current.error;
    expect(error).toBeInstanceOf(PayStubUnbalanced);
    expect((error as PayStubUnbalanced).balance).toEqual({
      gross_cents: 270_833,
      deductions_cents: 71_229,
      net_cents: 199_606,
      expected_net_cents: 199_604,
      difference_cents: -2,
    });
    expect(apiErrorMessage(error, 'x')).toMatch(/^Gross minus deductions is 199604 cents/);
    expect(db.payStubs).toHaveLength(0);
  });

  it('passes other errors through and refreshes the document on a state conflict', async () => {
    server.use(
      http.post(apiUrl('/docs/:id/confirm'), () =>
        HttpResponse.json(
          { error: { code: 'document_confirmed', message: 'This document is already confirmed' } },
          { status: 409 },
        ),
      ),
    );
    const { result, queryClient } = renderHookWithClient(() => useConfirmDocument());
    queryClient.setQueryData(queryKeys.document(PAY_STUB_DOC_ID), {});
    act(() => result.current.mutate({ documentId: PAY_STUB_DOC_ID, values: sampleValues }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).not.toBeInstanceOf(PayStubUnbalanced);
    expect(apiErrorMessage(result.current.error, 'x')).toBe('This document is already confirmed');
    expect(queryClient.getQueryState(queryKeys.document(PAY_STUB_DOC_ID))?.isInvalidated).toBe(
      true,
    );
  });

  it('sends a benefits summary under benefits and says when the profile changed', async () => {
    benefitsWaiting();
    const bodies: unknown[] = [];
    server.events.on('request:start', async ({ request }) => {
      if (request.method === 'POST') bodies.push(await request.clone().json());
    });
    const { result, queryClient } = renderHookWithClient(() => useConfirmDocument());
    queryClient.setQueryData(queryKeys.benefitsPlans(), []);
    queryClient.setQueryData(queryKeys.profile(), {});
    act(() =>
      result.current.mutate({ documentId: BENEFITS_DOC_ID, benefits: sampleBenefitsValues }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(bodies).toEqual([{ benefits: sampleBenefitsValues }]);
    expect(result.current.data?.profile_updated).toBe(true);
    expect(result.current.data?.plans).toHaveLength(2);
    expect(queryClient.getQueryState(queryKeys.benefitsPlans())?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(queryKeys.profile())?.isInvalidated).toBe(true);
  });

  it('treats a 422 without a readable diff as an ordinary error', async () => {
    server.use(
      http.post(apiUrl('/docs/:id/confirm'), () =>
        HttpResponse.json(
          { error: { code: 'pay_stub_unbalanced', message: 'off', details: { gross_cents: 'x' } } },
          { status: 422 },
        ),
      ),
    );
    const { result } = renderHookWithClient(() => useConfirmDocument());
    act(() => result.current.mutate({ documentId: BENEFITS_DOC_ID, values: sampleValues }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).not.toBeInstanceOf(PayStubUnbalanced);
  });
});
