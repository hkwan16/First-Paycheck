import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { $api } from './client';
import {
  invalidateAfterConfirm,
  invalidateDocuments,
  invalidateForJob,
  invalidateLinkedData,
  invalidateRecurring,
  invalidateSpending,
  JOB_INVALIDATES,
  queryKeys,
} from './keys';

function seeded() {
  const client = new QueryClient();
  const keys = {
    health: $api.queryOptions('get', '/health').queryKey,
    accounts: $api.queryOptions('get', '/accounts').queryKey,
    page: queryKeys.transactionPages({ limit: 50 }),
    count: $api.queryOptions('get', '/transactions', {
      params: { query: { account_id: 'a', limit: 200 } },
    }).queryKey,
  };
  for (const key of Object.values(keys)) client.setQueryData(key, {});
  const invalidated = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated;
  return { client, keys, invalidated };
}

describe('queryKeys', () => {
  it("match the keys $api's hooks cache under", () => {
    expect(queryKeys.accounts()).toEqual($api.queryOptions('get', '/accounts').queryKey);
    expect(queryKeys.job('j1')).toEqual(
      $api.queryOptions('get', '/jobs/{job_id}', { params: { path: { job_id: 'j1' } } }).queryKey,
    );
  });

  it('keep transaction pages under the transactions prefix but apart from plain reads', () => {
    const pages = queryKeys.transactionPages({ limit: 50 });
    expect(pages.slice(0, 2)).toEqual(queryKeys.transactions());
    expect(pages).not.toEqual(
      $api.queryOptions('get', '/transactions', { params: { query: { limit: 50 } } }).queryKey,
    );
  });
});

describe('invalidateForJob', () => {
  it('refreshes accounts and every transactions read after a sync', async () => {
    const { client, keys, invalidated } = seeded();
    await invalidateForJob(client, 'sync.initial');
    expect(invalidated(keys.accounts)).toBe(true);
    expect(invalidated(keys.page)).toBe(true);
    expect(invalidated(keys.count)).toBe(true);
    expect(invalidated(keys.health)).toBe(false);
  });

  it('refreshes transactions but not accounts after categorizing', async () => {
    const { client, keys, invalidated } = seeded();
    await invalidateForJob(client, 'categorize.run');
    expect(invalidated(keys.page)).toBe(true);
    expect(invalidated(keys.accounts)).toBe(false);
  });

  it('lists every job kind the API defines', () => {
    expect(Object.keys(JOB_INVALIDATES).sort()).toEqual(
      [
        'categorize.run',
        'checkin.monthly',
        'ingest.extract',
        'recurring.detect',
        'schedule.tick',
        'sync.incremental',
        'sync.initial',
      ].sort(),
    );
  });
});

describe('document keys', () => {
  function seededDocs() {
    const client = new QueryClient();
    const keys = {
      list: $api.queryOptions('get', '/docs').queryKey,
      detail: $api.queryOptions('get', '/docs/{document_id}', {
        params: { path: { document_id: 'd1' } },
      }).queryKey,
      payStubs: $api.queryOptions('get', '/pay-stubs').queryKey,
      profile: $api.queryOptions('get', '/profile').queryKey,
      accounts: $api.queryOptions('get', '/accounts').queryKey,
    };
    for (const key of Object.values(keys)) client.setQueryData(key, {});
    const invalidated = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated;
    return { client, keys, invalidated };
  }

  it("match the keys $api's hooks cache under", () => {
    expect(queryKeys.documents()).toEqual($api.queryOptions('get', '/docs').queryKey);
    expect(queryKeys.document('d1')).toEqual(
      $api.queryOptions('get', '/docs/{document_id}', { params: { path: { document_id: 'd1' } } })
        .queryKey,
    );
    expect(queryKeys.payStubs()).toEqual($api.queryOptions('get', '/pay-stubs').queryKey);
    expect(queryKeys.profile()).toEqual($api.queryOptions('get', '/profile').queryKey);
  });

  it('a finished extraction refreshes the list and every document read', async () => {
    const { client, keys, invalidated } = seededDocs();
    await invalidateForJob(client, 'ingest.extract');
    expect(invalidated(keys.list)).toBe(true);
    expect(invalidated(keys.detail)).toBe(true);
    expect(invalidated(keys.payStubs)).toBe(false);
  });

  it('invalidateDocuments refreshes the list and details only', async () => {
    const { client, keys, invalidated } = seededDocs();
    await invalidateDocuments(client);
    expect(invalidated(keys.list)).toBe(true);
    expect(invalidated(keys.detail)).toBe(true);
    expect(invalidated(keys.accounts)).toBe(false);
  });

  it('a confirmed document refreshes documents and pay stubs', async () => {
    const { client, keys, invalidated } = seededDocs();
    await invalidateAfterConfirm(client);
    expect(invalidated(keys.list)).toBe(true);
    expect(invalidated(keys.detail)).toBe(true);
    expect(invalidated(keys.payStubs)).toBe(true);
    expect(invalidated(keys.accounts)).toBe(false);
  });
});

describe('spending and recurring keys', () => {
  function seededSpending() {
    const client = new QueryClient();
    const keys = {
      cashflow: $api.queryOptions('get', '/cashflow').queryKey,
      cashflowAugust: $api.queryOptions('get', '/cashflow', {
        params: { query: { start: '2026-08-01', end: '2026-08-31' } },
      }).queryKey,
      summary: $api.queryOptions('get', '/spending/summary').queryKey,
      recurring: $api.queryOptions('get', '/recurring').queryKey,
      accounts: $api.queryOptions('get', '/accounts').queryKey,
    };
    for (const key of Object.values(keys)) client.setQueryData(key, {});
    const invalidated = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated;
    return { client, keys, invalidated };
  }

  it('prefix every period of a read', () => {
    const { keys } = seededSpending();
    expect(keys.cashflowAugust.slice(0, 2)).toEqual(queryKeys.cashflow());
    expect(keys.summary.slice(0, 2)).toEqual(queryKeys.spendingSummary());
    expect(keys.recurring.slice(0, 2)).toEqual(queryKeys.recurring());
  });

  it('a category fix refreshes the cash flow and summary of every period', async () => {
    const { client, keys, invalidated } = seededSpending();
    await invalidateSpending(client);
    expect(invalidated(keys.cashflow)).toBe(true);
    expect(invalidated(keys.cashflowAugust)).toBe(true);
    expect(invalidated(keys.summary)).toBe(true);
    expect(invalidated(keys.recurring)).toBe(false);
  });

  it('invalidateRecurring refreshes the recurring list only', async () => {
    const { client, keys, invalidated } = seededSpending();
    await invalidateRecurring(client);
    expect(invalidated(keys.recurring)).toBe(true);
    expect(invalidated(keys.cashflow)).toBe(false);
  });

  it('recurring detection refreshes the list; a CSV import refreshes accounts and spending', async () => {
    expect(JOB_INVALIDATES['recurring.detect']).toEqual([queryKeys.recurring()]);
    const { client, keys, invalidated } = seededSpending();
    await invalidateLinkedData(client);
    expect(invalidated(keys.accounts)).toBe(true);
    expect(invalidated(keys.cashflow)).toBe(true);
    expect(invalidated(keys.recurring)).toBe(false);
  });
});
