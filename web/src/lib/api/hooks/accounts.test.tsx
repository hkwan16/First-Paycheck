import { act, waitFor } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { CHECKING_ID, SAVINGS_ID, sampleAccounts } from '@/test/fixtures/sample';
import { db } from '@/test/msw/db';
import { apiUrl } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderHookWithClient } from '@/test/render';
import { queryKeys } from '../keys';
import type { Account } from '../types';
import { useAccounts, useAccountTransactionCount, useUpdateAccount } from './accounts';

describe('useAccounts', () => {
  it('reads every linked account', async () => {
    const { result } = renderHookWithClient(() => useAccounts());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(sampleAccounts);
  });
});

describe('useUpdateAccount', () => {
  function setup() {
    const rendered = renderHookWithClient(() => ({
      accounts: useAccounts(),
      update: useUpdateAccount(),
    }));
    return rendered;
  }
  const roleOf = (accounts: Account[] | undefined, id: string) =>
    accounts?.find((a) => a.id === id)?.role;

  it('shows the new role at once, then keeps what the server says', async () => {
    server.use(
      http.patch(apiUrl('/accounts/:id'), async ({ params, request }) => {
        await delay(50);
        const body = (await request.json()) as Partial<Account>;
        const account = db.accounts.find((a) => a.id === params.id)!;
        Object.assign(account, body);
        return HttpResponse.json(account);
      }),
    );
    const { result } = setup();
    await waitFor(() => expect(result.current.accounts.isSuccess).toBe(true));

    act(() =>
      result.current.update.mutate({
        accountId: CHECKING_ID,
        patch: { role: 'retirement', is_active: true },
      }),
    );
    await waitFor(() =>
      expect(roleOf(result.current.accounts.data, CHECKING_ID)).toBe('retirement'),
    );
    expect(result.current.update.isPending).toBe(true);
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    expect(roleOf(result.current.accounts.data, CHECKING_ID)).toBe('retirement');
  });

  it('refetches so a moved emergency fund role leaves the other account', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.accounts.isSuccess).toBe(true));
    expect(roleOf(result.current.accounts.data, SAVINGS_ID)).toBe('emergency_fund');

    act(() =>
      result.current.update.mutate({
        accountId: CHECKING_ID,
        patch: { role: 'emergency_fund', is_active: true },
      }),
    );
    await waitFor(() => expect(roleOf(result.current.accounts.data, SAVINGS_ID)).toBe(null));
    expect(roleOf(result.current.accounts.data, CHECKING_ID)).toBe('emergency_fund');
  });

  it('puts the old role back when the server refuses', async () => {
    server.use(
      http.patch(apiUrl('/accounts/:id'), () =>
        HttpResponse.json(
          { error: { code: 'not_found', message: 'Account not found' } },
          { status: 404 },
        ),
      ),
    );
    const { result } = setup();
    await waitFor(() => expect(result.current.accounts.isSuccess).toBe(true));
    act(() =>
      result.current.update.mutate({
        accountId: CHECKING_ID,
        patch: { role: null, is_active: false },
      }),
    );
    await waitFor(() => expect(result.current.update.isError).toBe(true));
    const checking = result.current.accounts.data?.find((a) => a.id === CHECKING_ID);
    expect(checking).toMatchObject({ role: 'spending', is_active: true });
  });
});

describe('useAccountTransactionCount', () => {
  it('counts the transactions of an account and finds the oldest', async () => {
    const { result } = renderHookWithClient(() => useAccountTransactionCount(CHECKING_ID));
    await waitFor(() =>
      expect(result.current).toEqual({ count: 16, more: false, since: '2026-10-01' }),
    );
  });

  it('says "more" when the account has more than one page', async () => {
    db.transactions = Array.from({ length: 205 }, (_, i) => ({
      ...db.transactions[0]!,
      id: `t-${i}`,
    }));
    const { result } = renderHookWithClient(() => useAccountTransactionCount(CHECKING_ID));
    await waitFor(() => expect(result.current?.more).toBe(true));
    expect(result.current?.count).toBe(200);
  });

  it('is undefined while loading', () => {
    const { result, queryClient } = renderHookWithClient(() =>
      useAccountTransactionCount(SAVINGS_ID),
    );
    expect(result.current).toBeUndefined();
    expect(
      queryClient.getQueryCache().findAll({ queryKey: queryKeys.transactions() }),
    ).toHaveLength(1);
  });
});
