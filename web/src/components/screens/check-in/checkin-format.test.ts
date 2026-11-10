import { describe, expect, it } from 'vitest';
import type { PlanLine } from '@/lib/api/types';
import {
  completedNovemberCheckIn,
  electionFinding,
  novemberCheckIn,
  novemberPlan,
} from '@/test/fixtures/checkins';
import {
  affectsView,
  checkInMonth,
  checkInNowMessage,
  checkInTitle,
  checkInWindow,
  findingTone,
  handledText,
  KIND_LABELS,
  offersCheckInNow,
  planBarValue,
  planStatusText,
  planStatusTone,
  severityTone,
} from './checkin-format';

describe('titles', () => {
  it('names the check-in by its month', () => {
    expect(checkInTitle('2026-11-01')).toBe('November check-in');
    expect(checkInMonth('2026-11-01')).toBe('November 2026');
  });
});

describe('severityTone', () => {
  it('reads the API severity as a status: alert is off, warning is warning, info is blue', () => {
    expect(severityTone('alert')).toBe('off');
    expect(severityTone('warning')).toBe('warning');
    expect(severityTone('info')).toBe('blue');
  });
});

describe('findingTone', () => {
  it('uses the severity while open and goes neutral once handled', () => {
    expect(findingTone(electionFinding())).toBe('off');
    expect(findingTone(completedNovemberCheckIn().findings[0]!)).toBe('neutral');
  });
});

describe('KIND_LABELS', () => {
  it('has a label for every finding kind', () => {
    expect(Object.keys(KIND_LABELS).sort()).toEqual(
      [
        'election_mismatch',
        'goal_off_pace',
        'pay_change',
        'recurring_changed',
        'recurring_new',
        'recurring_stopped',
        'upcoming_deadline',
        'overdue_deadline',
      ].sort(),
    );
    expect(KIND_LABELS.overdue_deadline).toBe('Overdue');
  });
});

describe('affectsView', () => {
  it('links each decision to the calculator that re-runs it, with its hue', () => {
    expect(affectsView('k401_match')).toEqual({
      label: 'Review your 401(k)',
      tone: 'plum',
      href: '/setup/decisions/401k',
    });
    expect(affectsView('health_plans')).toEqual({
      label: 'Review your health plan',
      tone: 'coral',
      href: '/setup/decisions/health-plan',
    });
    expect(affectsView('emergency_fund')).toEqual({
      label: 'Review your emergency fund',
      tone: 'teal',
      href: '/setup/decisions/emergency-fund',
    });
    expect(affectsView('w4')).toEqual({
      label: 'Review your W-4',
      tone: 'blue',
      href: '/setup/decisions/w4',
    });
    expect(affectsView('spending')).toEqual({
      label: 'See your spending',
      tone: 'blue',
      href: '/setup/spending',
    });
    expect(affectsView(null)).toBeNull();
  });
});

describe('handledText', () => {
  it('reads the counts the API (or the optimistic reducer) carries', () => {
    expect(handledText(novemberCheckIn())).toBe('0 of 7 handled');
    expect(handledText(completedNovemberCheckIn())).toBe('7 of 7 handled');
  });
});

describe('planStatusTone', () => {
  const line = (key: PlanLine['key'], status: PlanLine['status']): PlanLine => ({
    key,
    label: key,
    actual_cents: 0,
    plan_cents: status === null ? null : 10_000,
    difference_cents: null,
    status,
    needs_pay_stub: false,
  });

  it('reads the API status on the November lines', () => {
    expect(novemberPlan().map((l) => [l.key, planStatusTone(l)])).toEqual([
      ['income', 'neutral'],
      ['essentials', 'confirmed'],
      ['flexible', 'neutral'],
      ['other', 'neutral'],
      ['savings', 'confirmed'],
      ['retirement', 'warning'],
      ['health', 'confirmed'],
      ['left_over', 'neutral'],
    ]);
  });

  it('is confirmed on plan, whatever the line', () => {
    for (const key of ['essentials', 'savings', 'retirement', 'health'] as const) {
      expect(planStatusTone(line(key, 'on_plan'))).toBe('confirmed');
    }
  });

  it('asks for a look above the plan on spending lines, where less is not a problem', () => {
    for (const key of ['essentials', 'flexible', 'other'] as const) {
      expect(planStatusTone(line(key, 'over'))).toBe('warning');
      expect(planStatusTone(line(key, 'under'))).toBe('confirmed');
    }
  });

  it('asks for a look below the plan where more is not a problem', () => {
    for (const key of ['savings', 'retirement', 'income', 'left_over'] as const) {
      expect(planStatusTone(line(key, 'under'))).toBe('warning');
      expect(planStatusTone(line(key, 'over'))).toBe('confirmed');
    }
  });

  it('asks for a look either side on health premiums, which should match the chosen plan', () => {
    expect(planStatusTone(line('health', 'over'))).toBe('warning');
    expect(planStatusTone(line('health', 'under'))).toBe('warning');
  });

  it('stays neutral without a plan', () => {
    expect(planStatusTone(line('essentials', null))).toBe('neutral');
    expect(planStatusTone(line('savings', null))).toBe('neutral');
  });
});

describe('planStatusText', () => {
  it('says the status in words, and nothing without one', () => {
    expect(planStatusText('on_plan')).toBe('On plan');
    expect(planStatusText('over')).toBe('Over plan');
    expect(planStatusText('under')).toBe('Under plan');
    expect(planStatusText(null)).toBeNull();
  });
});

describe('planBarValue', () => {
  const line = (actual: number, plan: number | null): PlanLine => ({
    key: 'retirement',
    label: '401(k) from pay stubs',
    actual_cents: actual,
    status: null,
    needs_pay_stub: false,
    plan_cents: plan,
    difference_cents: null,
  });

  it('is the bar width: the actual as a share of the plan', () => {
    expect(planBarValue(line(5_417, 10_833))).toBeCloseTo(50.0046, 3);
    expect(planBarValue(line(30_000, 30_000))).toBe(100);
  });

  it('draws no bar without a plan to measure against', () => {
    expect(planBarValue(line(22_349, null))).toBeNull();
    expect(planBarValue(line(0, 0))).toBeNull();
  });
});

describe('offersCheckInNow', () => {
  it('is offered on this month’s open check-in only', () => {
    expect(offersCheckInNow(novemberCheckIn(), '2026-11-16')).toBe(true);
    expect(offersCheckInNow(novemberCheckIn(), '2026-11-30')).toBe(true);
  });

  it('is not offered on a completed check-in, another month’s, or before the clock is known', () => {
    expect(offersCheckInNow(completedNovemberCheckIn(), '2026-11-16')).toBe(false);
    expect(offersCheckInNow(novemberCheckIn(), '2026-12-01')).toBe(false);
    expect(offersCheckInNow(novemberCheckIn(), '2026-10-31')).toBe(false);
    expect(offersCheckInNow(novemberCheckIn(), null)).toBe(false);
  });
});

describe('checkInWindow', () => {
  it('runs to the end of the next month, with no start, so overdue dates are in it', () => {
    expect(checkInWindow('2026-11-01')).toEqual({ to: '2026-12-31' });
    expect(checkInWindow('2026-12-01')).toEqual({ to: '2027-01-31' });
    expect(checkInWindow('2027-01-01')).toEqual({ to: '2027-02-28' });
    expect(checkInWindow('2028-01-01')).toEqual({ to: '2028-02-29' });
  });
});

describe('checkInNowMessage', () => {
  const run = (outcome: 'created' | 'refreshed' | 'skipped', inserted = 0, retracted = 0) => ({
    outcome,
    checkInId: null,
    inserted,
    retracted,
  });

  it('says what a run on the check-in itself found, never just that it ran (issue 194)', () => {
    expect(checkInNowMessage(run('refreshed'), 'check-in')).toBe(
      'Checked again just now. No new findings.',
    );
    expect(checkInNowMessage(run('refreshed', 6), 'check-in')).toBe(
      'Checked again just now. 6 new findings.',
    );
    expect(checkInNowMessage(run('refreshed', 0, 1), 'check-in')).toBe(
      'Checked again just now. 1 finding no longer applies.',
    );
    expect(checkInNowMessage(run('refreshed', 1, 2), 'check-in')).toBe(
      'Checked again just now. 1 new finding. 2 findings no longer apply.',
    );
  });

  it('says what a run from the list made or changed', () => {
    expect(checkInNowMessage(run('created', 7), 'list')).toBe(
      'This month’s check-in is ready with 7 findings.',
    );
    expect(checkInNowMessage(run('created'), 'list')).toBe(
      'This month’s check-in is ready. Nothing changed against your plan.',
    );
    expect(checkInNowMessage(run('refreshed'), 'list')).toBe(
      'Checked this month again. No new findings.',
    );
    expect(checkInNowMessage(run('refreshed', 2), 'list')).toBe(
      'Checked this month again. 2 new findings.',
    );
  });

  it('says a completed month was left as it is, and nothing before a run ends', () => {
    for (const from of ['list', 'check-in'] as const) {
      expect(checkInNowMessage(run('skipped'), from)).toBe(
        'This month’s check-in is already complete, so nothing changed.',
      );
      expect(checkInNowMessage(null, from)).toBe('');
    }
  });
});
