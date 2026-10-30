import type {
  CalculatorKind,
  Decision,
  Explanation,
  Job,
  Plan,
  PlanDecision,
  PlanExplanation,
  PlanFigure,
} from '@/lib/api/types';
import {
  sampleCalendarEvent,
  sampleDecision,
  sampleExplanation,
  sampleFallbackExplanation,
} from './decisions';
import { samplePayStub } from './documents';
import {
  HEALTH_DECISION_ID,
  sampleEmergencyDecision,
  sampleGoal,
  sampleHealthDecision,
  samplePlanningEvents,
} from './planning';
import { sampleJob, SAMPLE_NOW } from './sample';
import { sampleW4Decision, sampleW4Event } from './w4';

/*
 * `GET /plan` (spec 016) for the sample user, built from the fixtures the
 * other screens use, so the Plan screen shows the same numbers as Decisions,
 * Why and the check-in: the four saved decisions (emergency fund, the 401(k)
 * at 4%, the Gold PPO and the W-4), the emergency fund goal, the calendar
 * events those decisions made and the confirmed Acme pay stub. Each figure is
 * copied from its decision by the key the API names (api/app/plan.py),
 * nothing is worked out here. Invented data only.
 */

/** The sample clock's date: the plan is read on Oct 17, 2026. */
export const PLAN_AS_OF = SAMPLE_NOW.slice(0, 10);
/** `as_of` plus 90 days (spec 016 rule 1), written out. */
export const PLAN_CALENDAR_THROUGH = '2027-01-15';

type FigureKind = PlanFigure['kind'];

/** The stored value at `inputs.a`, `result.b` or `result.plans[1].c`, as the API reads it. */
function valueAt(decision: Decision, key: string): PlanFigure['value'] {
  let value: unknown = decision;
  for (const part of key.split('.')) {
    const [, name, index] = /^([^[]+)(?:\[(\d+)\])?$/.exec(part)!;
    value = (value as Record<string, unknown>)[name!];
    if (index !== undefined) value = (value as unknown[])[Number(index)];
  }
  return value as PlanFigure['value'];
}

const figure = (decision: Decision, key: string, label: string, kind: FigureKind): PlanFigure => ({
  key,
  label,
  kind,
  value: valueAt(decision, key),
});

/** Rule 3's figures for one decision, in the API's order and with its labels. */
function figuresOf(decision: Decision): PlanFigure[] {
  const f = (key: string, label: string, kind: FigureKind) => figure(decision, key, label, kind);
  switch (decision.calculator) {
    case 'emergency_fund':
      return [
        f('result.target_cents', 'Target', 'money'),
        f('inputs.monthly_contribution_cents', 'Monthly contribution', 'money'),
        f('result.per_paycheck_contribution_cents', 'Per paycheck', 'money'),
        f('result.months_to_target', 'Months to target', 'count'),
        f('result.funded_pct', 'Funded today', 'percent'),
      ];
    case 'k401_match':
      return [
        f('inputs.contribution_pct', 'Your contribution', 'percent'),
        f('result.full_match_pct', 'Contribution for the full match', 'percent'),
        f('result.employer_match_cents_current', 'Employer match a year', 'money'),
        f('result.missed_cents', 'Match missed a year', 'money'),
      ];
    case 'health_plans': {
      const plan = `result.plans[${String(decision.result.selected_index)}]`;
      const usage = String(decision.inputs.expected_usage);
      return [
        f(`${plan}.name`, 'Plan', 'text'),
        f(`${plan}.${usage}_cost_cents`, `Expected cost a year at ${usage} use`, 'net_cost'),
        f(`${plan}.annual_premium_cents`, 'Premiums a year', 'money'),
        f(`${plan}.worst_case_cents`, 'Worst case a year', 'net_cost'),
      ];
    }
    case 'w4': {
      const found = [
        f('result.withholding_per_paycheck_cents', 'Federal withholding per paycheck', 'money'),
        f(
          'result.projected_tax_after_credits_cents',
          `Projected federal tax for ${String(decision.inputs.tax_year)}`,
          'money',
        ),
        f('result.projected_refund_cents', 'Projected refund (negative is owed)', 'money'),
      ];
      const suggestion = decision.result.suggestion;
      if (
        suggestion === 'increase_extra_withholding' ||
        suggestion === 'decrease_extra_withholding'
      ) {
        found.push(
          f(
            'result.suggested_extra_withholding_cents',
            'Suggested Step 4(c) extra withholding per paycheck',
            'money',
          ),
        );
      } else if (suggestion === 'increase_deductions') {
        found.push(
          f('result.suggested_deductions_cents', 'Suggested Step 4(b) deductions', 'money'),
        );
      }
      return found;
    }
  }
}

/** No explanation row yet (rule 4). */
export const noExplanation: PlanExplanation = {
  status: 'none',
  id: null,
  concept: null,
  text: null,
  created_at: null,
  citations: [],
};

/** A stored explanation row as the plan reports it. */
export const planExplanation = (row: Explanation): PlanExplanation => ({
  status: row.verified ? 'verified' : 'fallback',
  id: row.id,
  concept: row.concept,
  text: row.text,
  created_at: row.created_at,
  citations: [...row.citations],
});

/** One saved decision as `GET /plan` lists it. */
export function planDecision(
  decision: Decision,
  explanation: PlanExplanation = noExplanation,
): PlanDecision {
  return {
    id: decision.id,
    calculator: decision.calculator,
    version: decision.version,
    created_at: decision.created_at,
    inputs: structuredClone(decision.inputs),
    result: structuredClone(decision.result),
    figures: figuresOf(decision),
    explanation,
  };
}

const CALCULATORS: readonly CalculatorKind[] = [
  'emergency_fund',
  'k401_match',
  'health_plans',
  'w4',
];

/** `completeness` for the decisions given (rule 2), in calculator order. */
const completenessOf = (decisions: readonly PlanDecision[]) => {
  const saved = new Set(decisions.map((d) => d.calculator));
  return {
    saved: CALCULATORS.filter((c) => saved.has(c)),
    missing: CALCULATORS.filter((c) => !saved.has(c)),
  };
};

/** The pay stub fields the plan carries (`PlanPayStub`). */
function planPayStub() {
  const stub = samplePayStub();
  return {
    id: stub.id,
    employer_name: stub.employer_name,
    pay_frequency: stub.pay_frequency,
    pay_date: stub.pay_date,
    gross_cents: stub.gross_cents,
    federal_withholding_cents: stub.federal_withholding_cents,
    social_security_cents: stub.social_security_cents,
    medicare_cents: stub.medicare_cents,
    state_tax_cents: stub.state_tax_cents,
    retirement_contribution_cents: stub.retirement_contribution_cents,
    medical_premium_cents: stub.medical_premium_cents,
    other_deductions_cents: stub.other_deductions_cents,
    net_cents: stub.net_cents,
  };
}

/**
 * Every decision saved. The 401(k) explanation is verified, the health plan's
 * fell back to the calculator's text, and the W-4 and emergency fund have
 * none (an emergency fund is never explained, spec 011).
 */
export function samplePlan(overrides: Partial<Plan> = {}): Plan {
  const decisions = [
    planDecision(sampleEmergencyDecision()),
    planDecision(sampleDecision(), planExplanation(sampleExplanation())),
    planDecision(
      sampleHealthDecision(),
      planExplanation(
        sampleFallbackExplanation({
          id: 'e0000000-0000-4000-8000-0000000000c1',
          decision_id: HEALTH_DECISION_ID,
          citations: [],
        }),
      ),
    ),
    planDecision(sampleW4Decision()),
  ];
  const [contribution, enrollment] = samplePlanningEvents();
  return {
    as_of: PLAN_AS_OF,
    calendar_through: PLAN_CALENDAR_THROUGH,
    completeness: completenessOf(decisions),
    decisions,
    goals: [sampleGoal()],
    // Rule 6: due by Jan 15, by date then kind; the goal review (Jan 31) is past the window.
    calendar: [sampleCalendarEvent(), contribution!, sampleW4Event(), enrollment!],
    pay_stub: planPayStub(),
    ...overrides,
  };
}

/** Only the 401(k) saved: one decision, its check, the pay stub. */
export function partialPlan(): Plan {
  const decisions = [planDecision(sampleDecision(), planExplanation(sampleExplanation()))];
  return samplePlan({
    completeness: completenessOf(decisions),
    decisions,
    goals: [],
    calendar: [sampleCalendarEvent()],
  });
}

/** A user who has saved nothing (rule 8): an empty plan, no pay stub. */
export function emptyPlan(): Plan {
  return samplePlan({
    completeness: completenessOf([]),
    decisions: [],
    goals: [],
    calendar: [],
    pay_stub: null,
  });
}

/** `GET /plan/calendar.ics`'s file name and the first lines of its body. */
export const CALENDAR_FILENAME = 'first-paycheck-calendar.ics';
export const sampleCalendarFile = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//First Paycheck//Plan calendar//EN',
  'CALSCALE:GREGORIAN',
  'METHOD:PUBLISH',
  'X-WR-CALNAME:First Paycheck',
  'END:VCALENDAR',
  '',
].join('\r\n');

/** The PDF's file name for an export made on the sample date. */
export const PLAN_PDF_FILENAME = `first-paycheck-plan-${PLAN_AS_OF}.pdf`;
/** Stand-in PDF bytes: the header of a PDF file, which is all a test reads. */
export const samplePdfBytes = () => new TextEncoder().encode('%PDF-1.7\n% synthetic plan\n');

/** The n-th export's job id (1-based), as `POST /plan/export` hands them out in a test. */
export const exportJobId = (n: number) => `5e000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A `plan.export` job in one state. */
export function exportJob(id: string, overrides: Partial<Job> = {}): Job {
  return sampleJob({ id, kind: 'plan.export', created_at: SAMPLE_NOW, ...overrides });
}

/** An export from queued, through running, to succeeded. */
export function exportJobStates(id: string): Job[] {
  return [
    exportJob(id, { status: 'queued' }),
    exportJob(id, { status: 'running', progress: 50 }),
    exportJob(id, {
      status: 'succeeded',
      progress: 100,
      result: { size_bytes: 4096 },
      finished_at: SAMPLE_NOW,
    }),
  ];
}
