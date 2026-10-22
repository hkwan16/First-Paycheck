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
  planBarValue,
  planLineTone,
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
      href: '/setup/decisions',
    });
    expect(affectsView('health_plans')).toMatchObject({ label: 'Health plan', tone: 'coral' });
    expect(affectsView('emergency_fund')).toMatchObject({ label: 'Emergency fund', tone: 'teal' });
    expect(affectsView('w4')).toMatchObject({ label: 'W-4', tone: 'blue' });
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

describe('planLineTone', () => {
  it('gives each line the hue of what it is', () => {
    expect(novemberPlan().map((line) => [line.key, planLineTone(line.key)])).toEqual([
      ['take_home', 'plum'],
      ['essentials', 'blue'],
      ['flexible', 'coral'],
      ['other', 'neutral'],
      ['savings', 'teal'],
      ['retirement', 'plum'],
      ['health', 'coral'],
      ['left_over', 'neutral'],
    ]);
  });
});

describe('planBarValue', () => {
  const line = (actual: number, plan: number | null): PlanLine => ({
    key: 'retirement',
    label: '401(k) from pay stubs',
    actual_cents: actual,
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

describe('checkInWindow', () => {
  it('runs from the first of the month to the end of the next one', () => {
    expect(checkInWindow('2026-11-01')).toEqual({ from: '2026-11-01', to: '2026-12-31' });
    expect(checkInWindow('2026-12-01')).toEqual({ from: '2026-12-01', to: '2027-01-31' });
    expect(checkInWindow('2027-01-01')).toEqual({ from: '2027-01-01', to: '2027-02-28' });
    expect(checkInWindow('2028-01-01')).toEqual({ from: '2028-01-01', to: '2028-02-29' });
  });
});
