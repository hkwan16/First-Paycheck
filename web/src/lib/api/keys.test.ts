import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { $api } from './client';
import { invalidateForJob, JOB_INVALIDATES, queryKeys } from './keys';

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
