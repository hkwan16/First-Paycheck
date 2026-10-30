import { http, HttpResponse } from 'msw';
import { API_BASE_URL } from '@/lib/api/base-url';
import type {
  BenefitsPlan,
  BenefitsValues,
  CalendarEvent,
  ConfirmIn,
  Confirmed,
  Decision,
  EmergencyFundInput,
  EmergencyFundResult,
  Goal,
  GoalPatch,
  HealthPlansInput,
} from '@/lib/api/types';
import { BENEFITS_DOC_ID, sampleBenefitsDocument } from '../fixtures/documents';
import {
  EMERGENCY_DECISION_ID,
  emergencyFundResult,
  GOAL_ID,
  healthPlansResult,
  sampleBenefitsPlans,
  sampleBenefitsProposal,
  sampleEmergencyDecision,
  sampleGoal,
  sampleHealthDecision,
  samplePlanningEvents,
} from '../fixtures/planning';
import { SAMPLE_NOW } from '../fixtures/sample';
import { sampleW4Decision, sampleW4Event, w4Result } from '../fixtures/w4';
import { db } from './db';

/*
 * The M6 and M7 routes: `POST /calc/emergency-fund`, `POST /calc/health-plans`,
 * `POST /calc/w4`, `GET /goals`, `PATCH /goals/{id}`, `GET /benefits-plans`,
 * the benefits branch of `POST /docs/{id}/confirm`, and what saving an
 * emergency fund, health plan or W-4 decision computes and creates
 * (`planningCalculators`, read by `POST /decisions` in handlers.ts). Their own state is `planningDb`, reset
 * after every test (src/test/setup.ts); decisions, documents, the profile and
 * the calendar stay in `db`.
 */

export interface PlanningDb {
  /** Oldest first, as `GET /goals` lists them. */
  goals: Goal[];
  /** As `GET /benefits-plans` lists them: newest summary first. */
  benefitsPlans: BenefitsPlan[];
}

export const planningDb: PlanningDb = { goals: [], benefitsPlans: [] };

export function resetPlanningDb() {
  planningDb.goals = [];
  planningDb.benefitsPlans = [];
}

const apiUrl = (path: string) => `${API_BASE_URL}${path}`;

const appError = (status: number, code: string, message: string, details?: object) =>
  HttpResponse.json({ error: { code, message, ...(details ? { details } : {}) } }, { status });

const invalid = (message: string) => appError(422, 'validation_error', message);

let sequence = 0;
const nextId = (prefix: string) =>
  `${prefix}-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;

/** The sample benefits summary read and waiting on the Confirm screen. */
export function benefitsWaiting() {
  db.documents.push(structuredClone(sampleBenefitsDocument));
  db.proposals.set(BENEFITS_DOC_ID, structuredClone(sampleBenefitsProposal));
}

/** The emergency fund decision v1 at three months and $300, its goal and its events. */
export function savedEmergencyFund() {
  db.decisions.push(sampleEmergencyDecision());
  planningDb.goals = [sampleGoal()];
  db.calendar.push(
    ...samplePlanningEvents().filter((e) => e.decision_id === EMERGENCY_DECISION_ID),
  );
}

/** The health plan decision v1 (the Gold PPO) and its enrollment deadline. */
export function savedHealthPlan() {
  const decision = sampleHealthDecision();
  db.decisions.push(decision);
  db.calendar.push(...samplePlanningEvents().filter((e) => e.decision_id === decision.id));
}

/** The W-4 decision v1 (the sample with both saved decisions read in) and its reminder. */
export function savedW4() {
  db.decisions.push(sampleW4Decision());
  db.calendar.push(sampleW4Event());
}

/** The sample benefits summary confirmed: its two plans are the calculator's options. */
export function benefitsConfirmed() {
  planningDb.benefitsPlans = structuredClone([...sampleBenefitsPlans]);
}

// Dates, for the effects of a save: the sample's next pay date and day clamping (calc/pay_dates.py).

/** The next expected pay date in the sample (semi-monthly, last stub Oct 15, today Oct 17). */
const NEXT_PAY_DATE = '2026-10-31';
const TODAY = SAMPLE_NOW.slice(0, 10);

/** `calc/pay_dates.py:add_months`: the same day `months` later, clamped to the month's end. */
function addMonths(date: string, months: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const index = year * 12 + (month - 1) + months;
  const y = Math.floor(index / 12);
  const m = index % 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

const event = (decision: Decision, kind: CalendarEvent['kind'], title: string, due: string) => {
  const row: CalendarEvent = {
    id: nextId('ca000000'),
    kind,
    title,
    due_at: due,
    decision_id: decision.id,
    status: 'upcoming',
  };
  db.calendar.push(row);
  return row;
};

export interface DecisionEffects {
  calendar_event_id: string | null;
  goal_id: string | null;
}

/** How `POST /decisions` handles one calculator (spec 007 rules 2 and 14). */
export interface DecisionCalculator {
  /** The calculator's own result for the inputs (from a fixture), or undefined. */
  result: (inputs: unknown) => object | undefined;
  /** Refuse a decision that cannot be saved although its inputs are valid. */
  refuse?: (inputs: Record<string, unknown>) => Response | undefined;
  /** What the saved version creates (spec 011 rules 9-14, spec 012 rule 15). */
  effects: (decision: Decision) => DecisionEffects;
}

/** Spec 011 rule 11: the last contribution's date, from the sample's next pay date. */
function targetDate(result: EmergencyFundResult): string | null {
  const months = result.months_to_target;
  return months !== null && months >= 1 ? addMonths(NEXT_PAY_DATE, months - 1) : null;
}

/**
 * Spec 011 rule 17a: the goal's date at its own contribution, the decision's
 * other inputs through the calculator's fixture; undefined for a case the
 * fixture lacks, null without an emergency fund decision.
 */
function reprojectGoal(goal: Goal): string | null | undefined {
  const decision = db.decisions.find(
    (d) => d.id === goal.decision_id && d.calculator === 'emergency_fund',
  );
  if (!decision) return null;
  const result = emergencyFundResult({
    ...(decision.inputs as unknown as EmergencyFundInput),
    monthly_contribution_cents: goal.monthly_contribution_cents,
  });
  return result && targetDate(result);
}

/** Spec 011 rules 9-14: one goal per user, updated by each version, and its two events. */
function emergencyFundEffects(decision: Decision): DecisionEffects {
  const inputs = decision.inputs as unknown as EmergencyFundInput;
  const result = decision.result as unknown as EmergencyFundResult;
  const fields = {
    target_amount_cents: result.target_cents,
    monthly_contribution_cents: inputs.monthly_contribution_cents,
    decision_id: decision.id,
    status: 'active' as const,
    reached_at: null,
    target_date: targetDate(result),
    updated_at: SAMPLE_NOW,
  };
  let goal = planningDb.goals.find((g) => g.kind === 'emergency_fund');
  if (goal) {
    Object.assign(goal, fields);
  } else {
    const account = db.accounts.find((a) => a.role === 'emergency_fund' && a.is_active);
    goal = sampleGoal({
      ...fields,
      id: planningDb.goals.length === 0 ? GOAL_ID : nextId('a0a10000'),
      account_id: account?.id ?? null,
      current_balance_cents: account?.balance_cents ?? null,
      progress_pct: null,
      created_at: SAMPLE_NOW,
    });
    planningDb.goals.push(goal);
  }
  if (inputs.monthly_contribution_cents > 0 && !result.funded) {
    event(
      decision,
      'goal_contribution',
      'Make your first emergency fund contribution',
      NEXT_PAY_DATE,
    );
  }
  const review = event(
    decision,
    'goal_review',
    'Review your emergency fund progress',
    addMonths(NEXT_PAY_DATE, 3),
  );
  return { calendar_event_id: review.id, goal_id: goal.id };
}

/** Spec 012 rule 15: the enrollment deadline, when one is set and not past. */
function healthPlansEffects(decision: Decision): DecisionEffects {
  const deadline = (decision.inputs as unknown as HealthPlansInput).enrollment_deadline;
  if (!deadline || deadline < TODAY) return { calendar_event_id: null, goal_id: null };
  const row = event(decision, 'enrollment_deadline', 'Health plan enrollment deadline', deadline);
  return { calendar_event_id: row.id, goal_id: null };
}

/** Spec 014 rule 18: a reminder to hand the form to the employer by the next pay date. */
function w4Effects(decision: Decision): DecisionEffects {
  const row = event(
    decision,
    'w4_submit',
    'Give your employer your updated Form W-4',
    NEXT_PAY_DATE,
  );
  return { calendar_event_id: row.id, goal_id: null };
}

export const planningCalculators = {
  emergency_fund: { result: emergencyFundResult, effects: emergencyFundEffects },
  health_plans: {
    result: healthPlansResult,
    refuse: (inputs) =>
      inputs.selected_plan_index == null
        ? appError(422, 'plan_not_selected', 'Pick a plan before saving')
        : undefined,
    effects: healthPlansEffects,
  },
  w4: { result: w4Result, effects: w4Effects },
} satisfies Record<string, DecisionCalculator>;

const missingCase = (file: string, inputs: unknown) =>
  appError(500, 'test_fixture_missing', `${file} has no case for these inputs`, { inputs });

/** `PlanValues` and `RetirementValues` checks the API runs on a benefits confirm (spec 013 rules 10-11). */
function benefitsProblem(values: BenefitsValues): string | null {
  if (values.plans.length === 0 && !values.retirement) {
    return 'give at least one plan or the retirement part';
  }
  for (const plan of values.plans) {
    if (plan.employer_hsa_cents > 0 && plan.kind !== 'hdhp') {
      return 'Only a high-deductible plan can have an employer HSA contribution';
    }
    if (plan.deductible_cents > plan.oop_max_cents) {
      return "A plan's deductible must not be more than its out-of-pocket maximum";
    }
  }
  const tiers = values.retirement?.match_tiers ?? [];
  if (
    tiers.some(
      (t, i) => i > 0 && Number(t.employee_pct_upto) <= Number(tiers[i - 1]!.employee_pct_upto),
    )
  ) {
    return 'Each match tier must reach a higher contribution rate than the one before it';
  }
  return null;
}

const percent = (value: number | string) => Number(value).toFixed(2);

export const planningHandlers = [
  http.post(apiUrl('/calc/emergency-fund'), async ({ request }) => {
    const inputs: unknown = await request.json();
    const result = emergencyFundResult(inputs);
    return result ? HttpResponse.json(result) : missingCase('emergency-fund-results.json', inputs);
  }),

  http.post(apiUrl('/calc/health-plans'), async ({ request }) => {
    const inputs: unknown = await request.json();
    const result = healthPlansResult(inputs);
    return result ? HttpResponse.json(result) : missingCase('health-plans-results.json', inputs);
  }),

  http.post(apiUrl('/calc/w4'), async ({ request }) => {
    const inputs: unknown = await request.json();
    const result = w4Result(inputs);
    return result ? HttpResponse.json(result) : missingCase('w4-results.json', inputs);
  }),

  http.get(apiUrl('/goals'), () => HttpResponse.json(planningDb.goals)),

  http.patch<{ id: string }, GoalPatch>(apiUrl('/goals/:id'), async ({ params, request }) => {
    const goal = planningDb.goals.find((g) => g.id === params.id);
    if (!goal) return appError(404, 'not_found', 'Goal not found');
    const body = await request.json();
    if (Object.keys(body).length === 0) {
      return invalid('give at least one of status, monthly_contribution_cents, account_id');
    }
    const contribution = body.monthly_contribution_cents;
    if (contribution != null && contribution !== goal.monthly_contribution_cents) {
      const date = reprojectGoal({ ...goal, monthly_contribution_cents: contribution });
      if (date === undefined) {
        return missingCase('emergency-fund-results.json', {
          monthly_contribution_cents: contribution,
        });
      }
      goal.monthly_contribution_cents = contribution;
      goal.target_date = date;
    }
    if (body.status != null && body.status !== goal.status) {
      goal.status = body.status;
      goal.reached_at = body.status === 'reached' ? SAMPLE_NOW : null;
    }
    if ('account_id' in body) goal.account_id = body.account_id ?? null;
    goal.updated_at = SAMPLE_NOW;
    return HttpResponse.json(goal);
  }),

  http.get(apiUrl('/benefits-plans'), () => HttpResponse.json(planningDb.benefitsPlans)),

  // A benefits summary's confirm; a pay stub's falls through to handlers.ts.
  http.post<{ id: string }, ConfirmIn>(apiUrl('/docs/:id/confirm'), async ({ params, request }) => {
    const document = db.documents.find((d) => d.id === params.id);
    if (!document || document.type !== 'benefits') return undefined;
    if (document.status === 'confirmed') {
      return appError(409, 'document_confirmed', 'This document is already confirmed');
    }
    if (document.status !== 'proposed' && document.status !== 'manual_entry_required') {
      return appError(409, 'document_not_ready', 'This document has not been read yet');
    }
    const values = (await request.json()).benefits;
    if (!values) {
      return appError(422, 'wrong_document_type', "Send this document's values under its type");
    }
    const problem = benefitsProblem(values);
    if (problem) return invalid(problem);

    const plans: BenefitsPlan[] = values.plans.map((plan) => ({
      ...plan,
      coinsurance_pct: percent(plan.coinsurance_pct),
      id: nextId('be000000'),
      document_id: document.id,
      created_at: SAMPLE_NOW,
    }));
    planningDb.benefitsPlans.unshift(...plans);
    if (values.retirement) {
      db.profile = {
        ...db.profile,
        match_tiers: values.retirement.match_tiers.map((t) => ({
          employee_pct_upto: percent(t.employee_pct_upto),
          employer_pct: percent(t.employer_pct),
        })),
        vesting_years: values.retirement.vesting_years ?? null,
        updated_at: SAMPLE_NOW,
      };
    }
    db.proposals.delete(document.id);
    Object.assign(document, {
      status: 'confirmed',
      confirmed_at: SAMPLE_NOW,
      deleted_at: SAMPLE_NOW,
    });
    const confirmed: Confirmed = {
      document,
      pay_stub: null,
      plans,
      profile_updated: Boolean(values.retirement),
    };
    return HttpResponse.json(confirmed);
  }),
];
