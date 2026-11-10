'use client';

import { useId, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { apiErrorMessage } from '@/lib/api/errors';
import { useUpdateProfile } from '@/lib/api/hooks';
import type { Profile, SalaryReview } from '@/lib/api/types';
import { salaryQuestionText } from './decision-format';
import { profileInput } from './plan-details';

export interface SalaryQuestionProps {
  profile: Profile;
  question: SalaryReview;
  /** Called once the answer is saved, when the card calculates again. */
  onAnswered?: () => void;
}

/**
 * Which yearly salary to use (spec 005 rule 24c, spec 018 rule 5d, issue 221),
 * asked by the 401(k), health plan and W-4 cards in place of their calculator
 * while the newest pay stub's yearly pay differs from the saved salary. "Use"
 * saves the stub's figure, "Keep" the saved one; both name the stub, which
 * answers the question. The API never changes the salary on its own, and no
 * card works out a number from a salary nobody confirmed.
 */
export function SalaryQuestion({ profile, question, onAnswered }: SalaryQuestionProps) {
  const headingId = useId();
  const update = useUpdateProfile();
  const [choice, setChoice] = useState<'use' | 'keep' | null>(null);
  const text = salaryQuestionText(question);

  const answer = (which: 'use' | 'keep') => {
    setChoice(which);
    update.mutate(
      {
        ...profileInput(profile),
        salary_cents: which === 'use' ? question.annual_salary_cents : question.salary_cents,
        salary_pay_stub_id: question.pay_stub_id,
      },
      { onSuccess: onAnswered },
    );
  };

  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-control bg-well px-3.5 py-3"
    >
      <h3 id={headingId} className="m-0 text-small font-semibold text-ink-2">
        Which yearly salary should we use?
      </h3>
      <p className="m-0 text-small text-ink-2">{text.lead}</p>
      <p className="m-0 text-small text-ink-3">
        Your 401(k), health plan and W-4 all work from this salary, so they wait for your answer.
        Keep yours if that paycheck had overtime or a bonus.
      </p>
      {update.isError && (
        <Notice tone="warning" compact role="alert">
          {apiErrorMessage(update.error, 'Could not save your answer. Try again.')}
        </Notice>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          loading={update.isPending && choice === 'use'}
          onClick={() => answer('use')}
        >
          {text.use}
        </Button>
        <Button loading={update.isPending && choice === 'keep'} onClick={() => answer('keep')}>
          {text.keep}
        </Button>
      </div>
    </div>
  );
}
