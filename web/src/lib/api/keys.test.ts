import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { $api } from './client';
import {
  invalidateAfterConfirm,
  invalidateAfterDecision,
  invalidateCheckIn,
  invalidateDecisions,
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
        'plan.export',
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
      benefitsPlans: $api.queryOptions('get', '/benefits-plans').queryKey,
      accounts: $api.queryOptions('get', '/accounts').queryKey,
      plan: queryKeys.plan(),
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
    expect(queryKeys.benefitsPlans()).toEqual($api.queryOptions('get', '/benefits-plans').queryKey);
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

  it('a confirmed document refreshes documents, pay stubs, benefits plans and the profile', async () => {
    const { client, keys, invalidated } = seededDocs();
    await invalidateAfterConfirm(client);
    expect(invalidated(keys.list)).toBe(true);
    expect(invalidated(keys.detail)).toBe(true);
    expect(invalidated(keys.payStubs)).toBe(true);
    // A benefits summary writes plans, and its 401(k) match to the profile.
    expect(invalidated(keys.benefitsPlans)).toBe(true);
    expect(invalidated(keys.profile)).toBe(true);
    // The plan shows the newest confirmed pay stub.
    expect(invalidated(keys.plan)).toBe(true);
    expect(invalidated(keys.accounts)).toBe(false);
  });
});

describe('plan keys', () => {
  it("match the key $api's hook caches under", () => {
    expect(queryKeys.plan()).toEqual($api.queryOptions('get', '/plan').queryKey);
  });

  it('a sync refreshes goals and the plan, whose progress reads the new balances', async () => {
    for (const kind of ['sync.initial', 'sync.incremental'] as const) {
      const client = new QueryClient();
      client.setQueryData(queryKeys.goals(), []);
      client.setQueryData(queryKeys.plan(), {});
      await invalidateForJob(client, kind);
      expect(client.getQueryState(queryKeys.goals())?.isInvalidated).toBe(true);
      expect(client.getQueryState(queryKeys.plan())?.isInvalidated).toBe(true);
    }
  });

  it('a finished export changes no cached read', () => {
    expect(JOB_INVALIDATES['plan.export']).toEqual([]);
  });
});

describe('decision keys', () => {
  const body = { contribution_pct: '4.00' };

  function seededDecisions() {
    const client = new QueryClient();
    const keys = {
      list: $api.queryOptions('get', '/decisions').queryKey,
      one: $api.queryOptions('get', '/decisions/{decision_id}', {
        params: { path: { decision_id: 'dec1' } },
      }).queryKey,
      explanation: $api.queryOptions('get', '/decisions/{decision_id}/explanation', {
        params: { path: { decision_id: 'dec1' } },
      }).queryKey,
      calendar: $api.queryOptions('get', '/calendar').queryKey,
      plan: queryKeys.plan(),
      goals: queryKeys.goals(),
      calc: queryKeys.calc('/calc/401k-match', body),
      profile: $api.queryOptions('get', '/profile').queryKey,
    };
    for (const key of Object.values(keys)) client.setQueryData(key, {});
    const invalidated = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated;
    return { client, keys, invalidated };
  }

  it("match the keys $api's hooks cache under", () => {
    expect(queryKeys.decisions()).toEqual($api.queryOptions('get', '/decisions').queryKey);
    expect(queryKeys.decision('dec1')).toEqual(
      $api.queryOptions('get', '/decisions/{decision_id}', {
        params: { path: { decision_id: 'dec1' } },
      }).queryKey,
    );
    expect(queryKeys.explanation('dec1')).toEqual(
      $api.queryOptions('get', '/decisions/{decision_id}/explanation', {
        params: { path: { decision_id: 'dec1' } },
      }).queryKey,
    );
    expect(queryKeys.calendar()).toEqual($api.queryOptions('get', '/calendar').queryKey);
    expect(queryKeys.goals()).toEqual($api.queryOptions('get', '/goals').queryKey);
    expect(queryKeys.calc('/calc/401k-match', body)).toEqual(
      $api.queryOptions('post', '/calc/401k-match', { body: body as never }).queryKey,
    );
    expect(queryKeys.calc('/calc/401k-match', body).slice(0, 2)).toEqual(
      queryKeys.calc('/calc/401k-match'),
    );
  });

  it('a saved decision refreshes decisions, the calendar, the plan and goals', async () => {
    const { client, keys, invalidated } = seededDecisions();
    await invalidateAfterDecision(client);
    expect(invalidated(keys.list)).toBe(true);
    expect(invalidated(keys.one)).toBe(true);
    expect(invalidated(keys.calendar)).toBe(true);
    expect(invalidated(keys.plan)).toBe(true);
    expect(invalidated(keys.goals)).toBe(true);
    expect(invalidated(keys.explanation)).toBe(false);
    expect(invalidated(keys.calc)).toBe(false);
    expect(invalidated(keys.profile)).toBe(false);
  });

  it('invalidateDecisions refreshes only the decision reads', async () => {
    const { client, keys, invalidated } = seededDecisions();
    await invalidateDecisions(client);
    expect(invalidated(keys.list)).toBe(true);
    expect(invalidated(keys.one)).toBe(true);
    expect(invalidated(keys.calendar)).toBe(false);
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

describe('check-in, net worth and holdings keys', () => {
  function seededCheckIns() {
    const client = new QueryClient();
    const keys = {
      list: $api.queryOptions('get', '/check-ins').queryKey,
      one: $api.queryOptions('get', '/check-ins/{check_in_id}', {
        params: { path: { check_in_id: 'c1' } },
      }).queryKey,
      other: $api.queryOptions('get', '/check-ins/{check_in_id}', {
        params: { path: { check_in_id: 'c2' } },
      }).queryKey,
      netWorth: $api.queryOptions('get', '/net-worth', { params: { query: { months: 12 } } })
        .queryKey,
      holdings: $api.queryOptions('get', '/holdings').queryKey,
      calendar: $api.queryOptions('get', '/calendar', {
        params: { query: { from: '2026-11-01', to: '2026-12-31' } },
      }).queryKey,
    };
    for (const key of Object.values(keys)) client.setQueryData(key, {});
    const invalidated = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated;
    return { client, keys, invalidated };
  }

  it("match the keys $api's hooks cache under", () => {
    const { keys } = seededCheckIns();
    expect(queryKeys.checkIns()).toEqual(keys.list);
    expect(queryKeys.checkIn('c1')).toEqual(keys.one);
    expect(keys.one.slice(0, 2)).toEqual(queryKeys.checkIn());
    expect(keys.netWorth.slice(0, 2)).toEqual(queryKeys.netWorth());
    expect(queryKeys.holdings()).toEqual(keys.holdings);
    expect(keys.calendar.slice(0, 2)).toEqual(queryKeys.calendar());
  });

  it('a finding update refreshes that check-in and the list, not other check-ins', async () => {
    const { client, keys, invalidated } = seededCheckIns();
    await invalidateCheckIn(client, 'c1');
    expect(invalidated(keys.one)).toBe(true);
    expect(invalidated(keys.list)).toBe(true);
    expect(invalidated(keys.other)).toBe(false);
    expect(invalidated(keys.netWorth)).toBe(false);
  });

  it('a monthly check-in job refreshes the list and every check-in', async () => {
    const { client, keys, invalidated } = seededCheckIns();
    await invalidateForJob(client, 'checkin.monthly');
    expect(invalidated(keys.list)).toBe(true);
    expect(invalidated(keys.one)).toBe(true);
    expect(invalidated(keys.other)).toBe(true);
    expect(invalidated(keys.holdings)).toBe(false);
  });

  it('a sync refreshes net worth and holdings (new balances and positions)', async () => {
    const { client, keys, invalidated } = seededCheckIns();
    await invalidateForJob(client, 'sync.incremental');
    expect(invalidated(keys.netWorth)).toBe(true);
    expect(invalidated(keys.holdings)).toBe(true);
    expect(invalidated(keys.list)).toBe(false);
  });
});
