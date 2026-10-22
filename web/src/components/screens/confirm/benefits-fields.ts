import type {
  BenefitsValues,
  PlanKind,
  PlanValues,
  Proposal,
  ProposedField,
  RetirementValues,
} from '@/lib/api/types';
import { PLAN_KIND_LABELS } from '@/components/screens/decisions/health-plan-format';
import {
  initConfirmState,
  type Choice,
  type ConfirmState,
  type ReviewField,
} from './confirmReducer';

/*
 * A benefits summary on the Confirm screen (spec 013 rule 8): each plan, each
 * match tier and the vesting schedule become `confirmReducer` fields with keys
 * of their own (`plans.1.deductible_cents`, `match_tiers.0.employer_pct`,
 * `vesting_years`), so the pay stub's select, edit, confirm and confirm-all
 * apply unchanged. Nothing here adds up: a benefits summary has no math gate.
 */

const PLAN_KINDS: readonly PlanKind[] = ['hdhp', 'ppo', 'hmo'];

const KIND_CHOICES: readonly Choice[] = PLAN_KINDS.map((kind) => ({
  value: kind,
  label: PLAN_KIND_LABELS[kind],
}));

/** Vesting schedules run from immediate to ten years (`RetirementValues`). */
const MAX_VESTING_YEARS = 10;

const VESTING_CHOICES: readonly Choice[] = Array.from(
  { length: MAX_VESTING_YEARS + 1 },
  (_, n) => ({
    value: String(n),
    label: n === 0 ? 'Immediately' : n === 1 ? '1 year' : `${n} years`,
  }),
);

/** Plan fields a summary may leave out: not every plan prints a deadline or an HSA amount. */
const OPTIONAL_PLAN_FIELDS: ReadonlySet<string> = new Set([
  'employer_hsa_cents',
  'enrollment_deadline',
]);

const VESTING_FIELD: ProposedField = {
  key: 'vesting_years',
  label: 'Years to full vesting',
  kind: 'number',
  role: 'info',
  value: null,
  confidence: null,
  note: null,
};

interface Extra {
  group?: string;
  required: boolean;
  choices?: readonly Choice[];
}

/** A proposal's plans, tiers and vesting as review fields, in the order the proposal lists them. */
export function initBenefitsState(proposal: Proposal): ConfirmState {
  const fields: ProposedField[] = [];
  const extras = new Map<string, Extra>();
  const add = (field: ProposedField, key: string, extra: Extra) => {
    fields.push({ ...field, key });
    extras.set(key, extra);
  };

  (proposal.plans ?? []).forEach((plan, index) => {
    const group = `Plan ${index + 1}`;
    for (const field of plan.fields) {
      add(field, `plans.${index}.${field.key}`, {
        group,
        required: !OPTIONAL_PLAN_FIELDS.has(field.key),
        ...(field.key === 'kind' ? { choices: KIND_CHOICES } : {}),
      });
    }
  });
  const tiers = proposal.match_tiers ?? [];
  tiers.forEach((tier, index) => {
    const group = `Tier ${index + 1}`;
    for (const field of tier.fields) {
      add(field, `match_tiers.${index}.${field.key}`, { group, required: true });
    }
  });
  // Vesting describes the match, so without a match there is nothing to vest.
  if (tiers.length > 0) {
    add(proposal.vesting_years ?? VESTING_FIELD, 'vesting_years', {
      required: false,
      choices: VESTING_CHOICES,
    });
  }

  const state = initConfirmState(fields, { manual: false });
  return {
    ...state,
    fields: state.fields.map((f) => ({ ...f, ...extras.get(f.key) })),
  };
}

export interface ReviewSection {
  title: string;
  fields: ReviewField[];
}

export interface ReviewSections {
  plans: ReviewSection[];
  tiers: ReviewSection[];
  vesting: ReviewField | null;
}

/** `plans.1.name` as `['plans', 1, 'name']`; anything else as null. */
function splitKey(key: string): [string, number, string] | null {
  const match = /^(plans|match_tiers)\.(\d+)\.(\w+)$/.exec(key);
  return match ? [match[1]!, Number(match[2]), match[3]!] : null;
}

function grouped(fields: readonly ReviewField[], prefix: string): ReviewField[][] {
  const groups: ReviewField[][] = [];
  for (const field of fields) {
    const parts = splitKey(field.key);
    if (parts?.[0] !== prefix) continue;
    (groups[parts[1]] ??= []).push(field);
  }
  return groups.filter(Boolean);
}

/** The fields laid out as the screen shows them: one section per plan and tier, then vesting. */
export function reviewSections(fields: readonly ReviewField[]): ReviewSections {
  return {
    plans: grouped(fields, 'plans').map((planFields, index) => {
      const name = planFields.find((f) => f.key.endsWith('.name'))?.value;
      return {
        title:
          typeof name === 'string' && name ? `Plan ${index + 1}: ${name}` : `Plan ${index + 1}`,
        fields: planFields,
      };
    }),
    tiers: grouped(fields, 'match_tiers').map((tierFields, index) => ({
      title: `Tier ${index + 1}`,
      fields: tierFields,
    })),
    vesting: fields.find((f) => f.key === 'vesting_years') ?? null,
  };
}

const valuesOf = (fields: readonly ReviewField[]) =>
  Object.fromEntries(fields.map((f) => [f.key.slice(f.key.lastIndexOf('.') + 1), f.value]));

/**
 * The confirmed values as `POST /docs/{id}/confirm` takes them. Call it once
 * every field is confirmed. `retirement` is null when the summary describes no
 * match, so confirming it leaves the profile's own tiers alone.
 */
export function benefitsValues(fields: readonly ReviewField[]): BenefitsValues {
  const plans = grouped(fields, 'plans').map((planFields) => {
    const v = valuesOf(planFields);
    return {
      name: v.name,
      kind: v.kind,
      premium_per_period_cents: v.premium_per_period_cents,
      deductible_cents: v.deductible_cents,
      oop_max_cents: v.oop_max_cents,
      coinsurance_pct: v.coinsurance_pct,
      // The API stores a plan without an employer HSA contribution as 0.
      employer_hsa_cents: v.employer_hsa_cents ?? 0,
      enrollment_deadline: v.enrollment_deadline ?? null,
    } as PlanValues;
  });
  const tiers = grouped(fields, 'match_tiers').map((tierFields) => {
    const v = valuesOf(tierFields);
    return {
      employee_pct_upto: v.employee_pct_upto,
      employer_pct: v.employer_pct,
    } as RetirementValues['match_tiers'][number];
  });
  const vesting = fields.find((f) => f.key === 'vesting_years')?.value;
  return {
    plans,
    retirement:
      tiers.length > 0
        ? { match_tiers: tiers, vesting_years: typeof vesting === 'number' ? vesting : null }
        : null,
  };
}
