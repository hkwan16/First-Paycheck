import type {
  BenefitsPlan,
  HealthcareUsage,
  HealthPlanOption,
  HealthPlansResult,
  PlanCost,
  PlanKind,
  PlanPair,
} from '@/lib/api/types';
import { formatMoney, formatNetCost, formatRate, netCost } from '@/lib/money';
import { amountText, readAmount } from './decision-format';

/*
 * Words and plan tables for the health plan card, kept pure so they can be
 * tested on their own. Every cost and saving is a field of the calculator's
 * result; these only pick it out and put words around it.
 */

/**
 * The calculator's usage scenarios when nothing else is set: the defaults of
 * `HealthPlansInput` in api/openapi.json (a test keeps them equal). The card
 * sends them explicitly so its inputs compare equal to a saved decision's,
 * which the API stores with every default filled in.
 */
export const USAGE_DEFAULTS: Record<HealthcareUsage, number> = {
  low: 50_000,
  medium: 300_000,
  high: 1_000_000,
};

/** The most plans the calculator compares (`HealthPlansInput.plans` maxItems). */
export const MAX_PLANS = 8;

export const USAGES: readonly HealthcareUsage[] = ['low', 'medium', 'high'];

const USAGE_WORDS: Record<HealthcareUsage, string> = { low: 'Low', medium: 'Medium', high: 'High' };

export const PLAN_KIND_LABELS: Record<PlanKind, string> = {
  hdhp: 'High deductible (HDHP)',
  ppo: 'PPO',
  hmo: 'HMO',
};

const dollars = (cents: number) => formatMoney(cents, { decimals: 0 });

/**
 * "Medium · about $3,000": a usage scenario with its yearly medical spending.
 * As a table row, "Medium use · about $3,000".
 */
export const usageLabel = (usage: HealthcareUsage, cents: number, { row = false } = {}) =>
  `${USAGE_WORDS[usage]}${row ? ' use' : ''} · about ${dollars(cents)}`;

export interface BenefitsPlansChoice {
  /** The newest confirmed summary's plans, as the calculator takes them. */
  plans: HealthPlanOption[];
  /** The first enrollment deadline among them, or null. */
  deadline: string | null;
  /** Plans of that summary beyond what the calculator compares. */
  left: number;
}

/**
 * The plans to compare from `GET /benefits-plans`: the newest confirmed
 * summary's (the API lists it first, in its order), up to `MAX_PLANS`, with
 * its enrollment deadline. Null when no summary is confirmed.
 */
export function plansFromBenefits(
  confirmed: readonly BenefitsPlan[] | undefined,
): BenefitsPlansChoice | null {
  const first = confirmed?.[0];
  if (!confirmed || !first) return null;
  const newest = confirmed.filter((plan) => plan.document_id === first.document_id);
  const chosen = newest.slice(0, MAX_PLANS);
  return {
    plans: chosen.map((plan) => ({
      name: plan.name,
      kind: plan.kind,
      premium_per_period_cents: plan.premium_per_period_cents,
      deductible_cents: plan.deductible_cents,
      coinsurance_pct: plan.coinsurance_pct,
      oop_max_cents: plan.oop_max_cents,
      employer_hsa_cents: plan.employer_hsa_cents,
    })),
    deadline: chosen.find((plan) => plan.enrollment_deadline)?.enrollment_deadline ?? null,
    left: newest.length - chosen.length,
  };
}

/** A plan's expected yearly net cost at a usage scenario, as the API computed it. */
export function costAt(plan: PlanCost, usage: HealthcareUsage): number {
  switch (usage) {
    case 'low':
      return plan.low_cost_cents;
    case 'medium':
      return plan.medium_cost_cents;
    case 'high':
      return plan.high_cost_cents;
  }
}

/**
 * A plan's yearly net cost in whole dollars, as the comparison prints it: a
 * negative cost (the API's sign) reads as coming out ahead, "$260 ahead"
 * (spec 012 rule 17).
 */
export const costText = (cents: number) => formatNetCost(cents, { decimals: 0 });

/**
 * The result panel's headline: the API's recommendation at the expected usage.
 * A plan that comes out ahead "leaves you $260 ahead a year" rather than
 * costing "$260 ahead a year" (spec 012 rule 17).
 */
export function headline(result: HealthPlansResult, usage: HealthcareUsage): string {
  const plan = result.plans[result.recommended_index];
  if (!plan) return 'No plan to compare';
  const { amount, ahead } = netCost(costAt(plan, usage), { decimals: 0 });
  const least = `${plan.name} costs the least at ${usage} use`;
  return ahead ? `${least} and leaves you ${amount} ahead a year` : `${least}: ${amount} a year`;
}

/** "$100", "$100 and $200", "$100, $200 and $300". */
function listAmounts(cents: readonly number[]): string {
  const words = cents.map(dollars);
  return words.length < 2
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/**
 * One pair of plans in words, from the API's scan (spec 012 rule 9): which is
 * cheaper with no care, every spend at which that changes, and which is
 * cheaper once both have reached their out-of-pocket maximums. Nothing is
 * inferred between the scanned points.
 */
export function pairText(pair: PlanPair, names: readonly string[]): string {
  const a = names[pair.plan_a_index] ?? `Plan ${pair.plan_a_index + 1}`;
  const b = names[pair.plan_b_index] ?? `Plan ${pair.plan_b_index + 1}`;
  const name = (index: number | null) => (index === null ? null : (names[index] ?? null));
  const zero = name(pair.cheaper_at_zero_index);
  const end = name(pair.cheaper_at_end_index);
  if (pair.break_even_spends_cents.length === 0) {
    if (zero === null) return `${a} and ${b} cost the same at any amount of care.`;
    const other = zero === a ? b : a;
    return `${zero} costs less than ${other} at any amount of care.`;
  }
  return [
    zero === null
      ? `With no care, ${a} and ${b} cost the same.`
      : `With no care, ${zero} costs less.`,
    `The cheaper plan changes at ${listAmounts(pair.break_even_spends_cents)} of care a year.`,
    end === null
      ? 'Once both reach their out-of-pocket maximums, they cost the same.'
      : `Once both reach their out-of-pocket maximums, ${end} costs less.`,
  ].join(' ');
}

/** What an HSA-eligible plan's contribution does to federal income tax; null for other plans. */
export function hsaEffect(plan: PlanCost, result: HealthPlansResult): string | null {
  if (!plan.hsa_eligible) return null;
  const rate = formatRate(result.marginal_rate_used);
  const saves = `${formatMoney(plan.hsa_tax_savings_cents)} in federal income tax at your ${rate} marginal rate`;
  if (plan.hsa_capped) {
    return `With ${plan.name}, your HSA contribution is capped at ${formatMoney(plan.employee_hsa_cents)}, so that it and the employer's ${formatMoney(plan.employer_hsa_cents)} stay within the ${formatMoney(result.hsa_limit_cents)} limit. It saves ${saves}.`;
  }
  if (plan.employee_hsa_cents === 0) {
    return `${plan.name} lets you put money into an HSA before tax. Enter what you plan to put in to see what it saves.`;
  }
  return `With ${plan.name}, putting ${formatMoney(plan.employee_hsa_cents)} into your HSA saves ${saves}.`;
}

/** A plan labeled high-deductible that misses the year's HSA rules (spec 012 rule 3); else null. */
export function hdhpNotice(
  plan: PlanCost,
  result: HealthPlansResult,
  taxYear: number,
): string | null {
  if (plan.kind !== 'hdhp' || plan.hsa_eligible) return null;
  return `${plan.name} is labeled a high-deductible plan but does not meet the ${taxYear} HSA rules (a deductible of at least ${dollars(result.hdhp_min_deductible_cents)} and an out-of-pocket maximum of at most ${dollars(result.hdhp_max_oop_cents)}), so you cannot put money into an HSA with it.`;
}

// Plans typed by hand, when no benefits summary is confirmed.

export interface PlanDraft {
  name: string;
  kind: PlanKind | '';
  premium: string;
  deductible: string;
  coinsurance: string;
  oopMax: string;
  /** Only read for a high-deductible plan; any other plan sends 0. */
  employerHsa: string;
}

export type PlanDraftField = keyof PlanDraft;
export type PlanDraftErrors = Partial<Record<PlanDraftField, string>>;

export const EMPTY_PLAN_DRAFT: PlanDraft = {
  name: '',
  kind: '',
  premium: '',
  deductible: '',
  coinsurance: '',
  oopMax: '',
  employerHsa: '',
};

/** "20.00" as a person types it: "20". */
const typedPercent = (stored: string | number) => String(Number(stored));

export function draftFromOption(plan: HealthPlanOption): PlanDraft {
  return {
    name: plan.name,
    kind: plan.kind,
    premium: amountText(plan.premium_per_period_cents),
    deductible: amountText(plan.deductible_cents),
    coinsurance: typedPercent(plan.coinsurance_pct),
    oopMax: amountText(plan.oop_max_cents),
    employerHsa: plan.kind === 'hdhp' ? amountText(plan.employer_hsa_cents) : '',
  };
}

const PERCENT = /^\d{1,3}(?:\.\d{1,2})?$/;
const PERCENT_ERROR = 'Enter a percentage from 0 to 100, like 20.';

/** An amount a plan needs, with what to fix; empty is missing here. */
function required(text: string, example: string) {
  const read = readAmount(text, { example });
  return read.cents === null
    ? { cents: null, error: read.error ?? `Enter an amount, like ${example}.` }
    : read;
}

export type ReadPlans =
  { ok: true; plans: HealthPlanOption[] } | { ok: false; errors: PlanDraftErrors[] };

/**
 * The typed plans as the calculator takes them (percentages in the API's
 * two-place form), or what to fix in each. The API checks again: a
 * deductible above the out-of-pocket maximum comes back as its 422.
 */
export function readPlanDrafts(drafts: readonly PlanDraft[]): ReadPlans {
  const plans: HealthPlanOption[] = [];
  const errors = drafts.map((draft) => {
    const problems: PlanDraftErrors = {};
    const name = draft.name.trim();
    if (name === '') problems.name = 'Enter the plan name.';
    if (draft.kind === '') problems.kind = 'Choose the plan type.';
    const premium = required(draft.premium, '62.50');
    const deductible = required(draft.deductible, '250.00');
    const coinsurance = draft.coinsurance.trim();
    const oopMax = required(draft.oopMax, '3,000.00');
    const hsa =
      draft.kind === 'hdhp'
        ? readAmount(draft.employerHsa, { example: '600.00' })
        : { cents: 0, error: null };
    if (premium.error) problems.premium = premium.error;
    if (deductible.error) problems.deductible = deductible.error;
    if (!PERCENT.test(coinsurance) || Number(coinsurance) > 100) {
      problems.coinsurance = PERCENT_ERROR;
    }
    if (oopMax.error) problems.oopMax = oopMax.error;
    if (hsa.error) problems.employerHsa = hsa.error;
    if (
      Object.keys(problems).length === 0 &&
      draft.kind !== '' &&
      premium.cents !== null &&
      deductible.cents !== null &&
      oopMax.cents !== null
    ) {
      plans.push({
        name,
        kind: draft.kind,
        premium_per_period_cents: premium.cents,
        deductible_cents: deductible.cents,
        coinsurance_pct: Number(coinsurance).toFixed(2),
        oop_max_cents: oopMax.cents,
        employer_hsa_cents: hsa.cents ?? 0,
      });
    }
    return problems;
  });
  return errors.some((problems) => Object.keys(problems).length > 0)
    ? { ok: false, errors }
    : { ok: true, plans };
}
