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
        'deduction_change',
        'election_mismatch',
        'goal_off_pace',
        'pay_change',
        'recurring_changed',
        'recurring_new',
        'recurring_stopped',
        'upcoming_deadline',
      ].sort(),
    );
  });
});

describe('affectsView', () => {
  it('links each decision to the calculator that re-runs it, with its hue', () => {
    expect(affectsView('k401_match')).toEqual({
      label: '401(k) match',
      tone: 'plum',
      href: '/setup/decisions/401k',
    });
    expect(affectsView('health_plans')).toEqual({
      label: 'Health plan',
      tone: 'coral',
      href: '/setup/decisions/health-plan',
    });
    expect(affectsView('emergency_fund')).toEqual({
      label: 'Emergency fund',
      tone: 'teal',
      href: '/setup/decisions/emergency-fund',
    });
    expect(affectsView('w4')).toEqual({ label: 'W-4', tone: 'blue', href: '/setup/decisions/w4' });
    expect(affectsView('spending')).toEqual({
      label: 'Spending map',
      tone: 'blue',
      href: '/setup/spending',
    });
    expect(affectsView(null)).toBeNull();
  });
});

describe('handledText', () => {
  it('reads the counts the API (or the optimistic reducer) carries', () => {
    expect(handledText(novemberCheckIn())).toBe('0 of 9 handled');
    expect(handledText(completedNovemberCheckIn())).toBe('9 of 9 handled');
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
  });

  it('reads the API status on the November lines', () => {
    expect(novemberPlan().map((l) => [l.key, planStatusTone(l)])).toEqual([
      ['take_home', 'neutral'],
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
    for (const key of ['savings', 'retirement', 'take_home', 'left_over'] as const) {
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
  it('runs from the first of the month to the end of the next one', () => {
    expect(checkInWindow('2026-11-01')).toEqual({ from: '2026-11-01', to: '2026-12-31' });
    expect(checkInWindow('2026-12-01')).toEqual({ from: '2026-12-01', to: '2027-01-31' });
    expect(checkInWindow('2027-01-01')).toEqual({ from: '2027-01-01', to: '2027-02-28' });
    expect(checkInWindow('2028-01-01')).toEqual({ from: '2028-01-01', to: '2028-02-29' });
  });
});
