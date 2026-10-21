import { act, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFakeXhr } from '@/test/fake-xhr';
import { server } from '@/test/msw/server';
import { renderHookWithClient } from '@/test/render';
import { API_BASE_URL } from '../base-url';
import { queryKeys } from '../keys';
import { UploadError } from '../upload';
import { useImportCsv } from './imports';

const csv = () => new File(['Date,Description,Amount\n'], 'export.csv', { type: 'text/csv' });

afterEach(() => {
  vi.unstubAllGlobals();
  server.events.removeAllListeners();
});

describe('useImportCsv', () => {
  it('imports over XHR with progress, then refreshes accounts and spending reads', async () => {
    const xhr = installFakeXhr();
    const { result, queryClient } = renderHookWithClient(() => useImportCsv());
    queryClient.setQueryData(queryKeys.accounts(), []);
    queryClient.setQueryData([...queryKeys.cashflow(), undefined], {});
    queryClient.setQueryData(queryKeys.recurring(), []);
    const progress: number[] = [];

    act(() =>
      result.current.mutate({
        file: csv(),
        account: { kind: 'checking' },
        sign: 'negative_is_out',
        onProgress: (p) => progress.push(p),
      }),
    );
    await waitFor(() => expect(xhr.requests).toHaveLength(1));
    const request = xhr.last();
    expect(request.url).toBe(`${API_BASE_URL}/accounts/import`);
    request.progress(1, 2);
    request.respond(200, {
      account: { id: 'a1' },
      imported: 3,
      categorize_job_id: 'j1',
      recurring_job_id: 'j2',
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(progress).toEqual([50]);
    expect(result.current.data?.imported).toBe(3);
    const invalidated = (key: readonly unknown[]) => queryClient.getQueryState(key)?.isInvalidated;
    expect(invalidated(queryKeys.accounts())).toBe(true);
    expect(invalidated([...queryKeys.cashflow(), undefined])).toBe(true);
    // Recurring charges change when the detection job finishes (useJob), not now.
    expect(invalidated(queryKeys.recurring())).toBe(false);
  });

  it('fails with an UploadError and changes nothing', async () => {
    const xhr = installFakeXhr();
    const { result, queryClient } = renderHookWithClient(() => useImportCsv());
    queryClient.setQueryData(queryKeys.accounts(), []);
    act(() =>
      result.current.mutate({
        file: csv(),
        account: { kind: 'checking' },
        sign: 'negative_is_out',
      }),
    );
    await waitFor(() => expect(xhr.requests).toHaveLength(1));
    xhr.last().respond(409, {
      error: {
        code: 'import_conflict',
        message: 'Another import into this account finished first; try again',
      },
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(UploadError);
    expect((result.current.error as UploadError).code).toBe('import_conflict');
    expect(queryClient.getQueryState(queryKeys.accounts())?.isInvalidated).toBe(false);
  });
});
