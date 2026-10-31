'use client';

import { useId, useState, type FormEvent, type Ref } from 'react';
import { Button } from '@/components/ui/Button';
import { FieldError } from '@/components/ui/FieldError';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Select } from '@/components/ui/Select';
import type { HealthPlanOption, PlanKind } from '@/lib/api/types';
import { cancelOnEscape } from '@/lib/escape-cancel';
import { useFocusHandoff } from '@/lib/focus-handoff';
import { AmountField } from './AmountField';
import {
  draftFromOption,
  EMPTY_PLAN_DRAFT,
  MAX_PLANS,
  PLAN_KIND_LABELS,
  readPlanDrafts,
  type PlanDraft,
  type PlanDraftErrors,
} from './health-plan-format';

export interface PlanOptionsFormProps {
  /** The plans to start from; none starts one empty plan. */
  initial: readonly HealthPlanOption[] | null;
  onCompare: (plans: HealthPlanOption[]) => void;
  /** Shown as Cancel when there are plans to go back to; Escape does it too. */
  onCancel?: () => void;
  /** Shown when a confirmed benefits summary has plans to go back to. */
  onUseBenefits?: () => void;
  /** The form, which takes focus (its first field) when it opens in place of a button. */
  ref?: Ref<HTMLFormElement>;
}

const KINDS = Object.entries(PLAN_KIND_LABELS) as [PlanKind, string][];

/**
 * The health plans to compare, typed by hand: name, type, premium per
 * paycheck, deductible, coinsurance, out-of-pocket maximum and (for a
 * high-deductible plan) the employer's HSA money, employee-only and in
 * network (spec 012 inputs). Up to the calculator's eight. Nothing here is
 * saved on its own; the plans go into the decision's inputs.
 */
export function PlanOptionsForm({
  initial,
  onCompare,
  onCancel,
  onUseBenefits,
  ref,
}: PlanOptionsFormProps) {
  const id = useId();
  // A plan added or removed: focus the name of the plan in its place (issue 167).
  const focus = useFocusHandoff<`plan-${number}`>();
  const [drafts, setDrafts] = useState<PlanDraft[]>(() =>
    initial && initial.length > 0 ? initial.map(draftFromOption) : [{ ...EMPTY_PLAN_DRAFT }],
  );
  const [errors, setErrors] = useState<PlanDraftErrors[]>([]);

  const change = (index: number, next: Partial<PlanDraft>) =>
    setDrafts((all) => all.map((draft, i) => (i === index ? { ...draft, ...next } : draft)));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const read = readPlanDrafts(drafts);
    if (!read.ok) {
      setErrors(read.errors);
      return;
    }
    setErrors([]);
    onCompare(read.plans);
  };

  return (
    <form
      ref={ref}
      aria-label="Your health plan options"
      noValidate
      onSubmit={submit}
      onKeyDown={cancelOnEscape(onCancel)}
      className="flex flex-col gap-4"
    >
      <p className="m-0 text-small text-ink-3">
        Enter each medical plan your employer offers, for employee-only coverage in network. Your
        benefits summary or enrollment site lists them.
      </p>
      {drafts.map((draft, index) => {
        const problems = errors[index] ?? {};
        const field = (name: string) => `${id}-${index}-${name}`;
        const describe = (name: keyof PlanDraft) =>
          problems[name] ? `${field(name)}-error` : undefined;
        return (
          <fieldset
            key={index}
            className="m-0 flex min-w-0 flex-col gap-3 rounded-tile border border-line px-4 pt-2 pb-4"
          >
            <legend className="px-1 text-small font-semibold text-ink-2">Plan {index + 1}</legend>
            <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
              <div>
                <Label htmlFor={field('name')}>Plan name</Label>
                <Input
                  ref={focus.target(`plan-${index}`)}
                  id={field('name')}
                  autoComplete="off"
                  maxLength={200}
                  value={draft.name}
                  invalid={Boolean(problems.name)}
                  aria-describedby={describe('name')}
                  onChange={(event) => change(index, { name: event.currentTarget.value })}
                />
                <FieldError id={`${field('name')}-error`}>{problems.name}</FieldError>
              </div>
              <div>
                <Label htmlFor={field('kind')}>Plan type</Label>
                <Select
                  id={field('kind')}
                  value={draft.kind}
                  invalid={Boolean(problems.kind)}
                  aria-describedby={describe('kind')}
                  onChange={(event) =>
                    change(index, { kind: event.currentTarget.value as PlanKind | '' })
                  }
                >
                  <option value="">Choose one</option>
                  {KINDS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
                <FieldError id={`${field('kind')}-error`}>{problems.kind}</FieldError>
              </div>
              <AmountField
                id={field('premium')}
                label="Premium per paycheck"
                value={draft.premium}
                error={problems.premium ?? null}
                onChange={(premium) => change(index, { premium })}
              />
              <AmountField
                id={field('deductible')}
                label="Deductible"
                value={draft.deductible}
                error={problems.deductible ?? null}
                onChange={(deductible) => change(index, { deductible })}
              />
              <div>
                <Label htmlFor={field('coinsurance')}>Coinsurance, %</Label>
                <Input
                  id={field('coinsurance')}
                  inputMode="decimal"
                  autoComplete="off"
                  value={draft.coinsurance}
                  invalid={Boolean(problems.coinsurance)}
                  aria-describedby={describe('coinsurance')}
                  onChange={(event) => change(index, { coinsurance: event.currentTarget.value })}
                  className="tabular-nums"
                />
                <FieldError id={`${field('coinsurance')}-error`}>{problems.coinsurance}</FieldError>
              </div>
              <AmountField
                id={field('oop')}
                label="Out-of-pocket maximum"
                value={draft.oopMax}
                error={problems.oopMax ?? null}
                onChange={(oopMax) => change(index, { oopMax })}
              />
              {draft.kind === 'hdhp' && (
                <AmountField
                  id={field('hsa')}
                  label="Employer HSA money per year"
                  value={draft.employerHsa}
                  error={problems.employerHsa ?? null}
                  placeholder="0.00"
                  onChange={(employerHsa) => change(index, { employerHsa })}
                />
              )}
            </div>
            {drafts.length > 1 && (
              <div>
                <Button
                  size="sm"
                  aria-label={`Remove plan ${index + 1}`}
                  onClick={() => {
                    focus.moveTo(`plan-${Math.min(index, drafts.length - 2)}`);
                    setDrafts((all) => all.filter((_, i) => i !== index));
                    setErrors((all) => all.filter((_, i) => i !== index));
                  }}
                >
                  Remove
                </Button>
              </div>
            )}
          </fieldset>
        );
      })}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary">
          Compare these plans
        </Button>
        {drafts.length < MAX_PLANS && (
          <Button
            onClick={() => {
              focus.moveTo(`plan-${drafts.length}`);
              setDrafts((all) => [...all, { ...EMPTY_PLAN_DRAFT }]);
            }}
          >
            Add a plan
          </Button>
        )}
        {onUseBenefits && <Button onClick={onUseBenefits}>Use your benefits summary</Button>}
        {onCancel && <Button onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}
