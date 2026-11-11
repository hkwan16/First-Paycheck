import type { Route } from 'next';
import type { ReactNode } from 'react';
import { ClockIcon, WhatIfIcon } from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { KV, KVList } from '@/components/ui/KV';
import { Notice, type NoticeProps } from '@/components/ui/Notice';
import type { CalendarEvent, Explanation } from '@/lib/api/types';
import { formatDate } from '@/lib/dates';
import { sentenceCase } from '@/lib/explanations';

/*
 * The Why page's explanation, from docs/mockup/Why.dc.html. One note says
 * what state it is in (spec 008 rule 19b, issue 204): checked, written from
 * information that has changed since, or not written. The note speaks to the
 * person, so it names no prompt version, retry or check count.
 */

const NOTE_LABEL = 'About this explanation';

/** Why a stale explanation may be wrong now (spec 008 rule 19b). */
export const STALE_TEXT =
  'Some of what it was written from has changed since, so a number here may be out of date.';

/** The explanation's paragraphs (the API separates them with a blank line). */
const paragraphs = (text: string) =>
  text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);

/** The note's frame: one compact notice, with its action at the end of the row. */
function Note({
  tone,
  icon,
  action,
  label = NOTE_LABEL,
  children,
}: Pick<NoticeProps, 'tone' | 'icon'> & {
  action?: ReactNode;
  label?: string;
  children: ReactNode;
}) {
  return (
    <Notice tone={tone} icon={icon} compact role="region" aria-label={label}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <span>{children}</span>
        {action}
      </div>
    </Notice>
  );
}

/**
 * A decision a newer version replaced (spec 008 rule 19c, issue 227): said in
 * place of the explanation's note, with the way to the current one. `replacedOn`
 * is the current version's save, unknown until the list of decisions loads.
 */
export function ReplacedNote({
  savedOn,
  replacedOn,
  current,
}: {
  savedOn: string;
  replacedOn: string | undefined;
  current: Route;
}) {
  return (
    <Note
      tone="blue"
      label="About this decision"
      action={
        <Button size="sm" href={current}>
          See the current decision
        </Button>
      }
    >
      You saved a newer version of this decision
      {replacedOn ? ` on ${formatDate(replacedOn)}` : ''}. This page keeps the one you saved on{' '}
      {formatDate(savedOn)} as it was.
    </Note>
  );
}

/** A current verified explanation: every number and source was checked. */
export function CheckedNote({ explanation }: { explanation: Explanation }) {
  return (
    <Note tone="confirmed">
      We checked every number here against the decision you saved, and each source links to the IRS
      page it quotes. Written {formatDate(explanation.created_at)}.
    </Note>
  );
}

/** A verified explanation written from information that has changed since, and `action`. */
export function StaleNote({
  explanation,
  action,
}: {
  explanation: Explanation;
  action: ReactNode;
}) {
  return (
    <Note tone="blue" icon={<ClockIcon size={16} className="text-blue-text" />} action={action}>
      Written {formatDate(explanation.created_at)}. {STALE_TEXT}
    </Note>
  );
}

/** No explanation that matched the saved numbers could be written; `action` tries again. */
export function NotWrittenNote({
  explanation,
  action,
}: {
  explanation: Explanation;
  action: ReactNode;
}) {
  return (
    <Note tone="warning" action={action}>
      We could not write an explanation that matches your numbers, so here are the numbers you
      saved.
      {explanation.stale && ' Some of your information has changed since.'}
    </Note>
  );
}

/** The verified explanation's main column: what it means, its numbers and what-ifs. */
export function VerifiedBody({ explanation }: { explanation: Explanation }) {
  return (
    <>
      <Card aria-labelledby="meaning-title" gap={14}>
        <h2 id="meaning-title" className="m-0">
          What this means
        </h2>
        <div className="flex flex-col gap-2.5 text-lead leading-[1.6]">
          <p className="m-0 font-semibold">{explanation.concept}</p>
          {paragraphs(explanation.text).map((paragraph, index) => (
            <p key={index} className="m-0">
              {paragraph}
            </p>
          ))}
        </div>
      </Card>

      {explanation.numbers.length > 0 && (
        <Card aria-labelledby="numbers-title" gap={14}>
          <h2 id="numbers-title" className="m-0">
            Your numbers
          </h2>
          <KVList spacing="comfortable">
            {explanation.numbers.map((claim, index) => (
              <KV key={index} label={sentenceCase(claim.label)} value={claim.value} />
            ))}
          </KVList>
        </Card>
      )}

      {explanation.what_ifs.length > 0 && (
        <Card aria-labelledby="change-title" gap={14}>
          <h2 id="change-title" className="m-0">
            What would change this
          </h2>
          <ul className="m-0 list-none p-0">
            {explanation.what_ifs.map((whatIf, index) => (
              <li
                key={index}
                className="flex items-start gap-3 border-t border-line py-2.5 first:border-t-0 first:pt-0"
              >
                <WhatIfIcon className="mt-[3px] flex-none text-coral" />
                <span>{whatIf}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

/**
 * From the mockup's "What happens next": the check this decision scheduled,
 * and the way back to its step (`change`).
 */
export function NextSteps({ event, change }: { event: CalendarEvent | undefined; change: Route }) {
  return (
    <Card aria-labelledby="next-title" gap={14}>
      <h2 id="next-title" className="m-0">
        What happens next
      </h2>
      <p className="m-0 text-small text-ink-3">
        {event ? (
          <>
            On {formatDate(event.due_at)}: {event.title}. Your monthly check-in will tell you if
            your pay stub does not show the change.
          </>
        ) : (
          'Your monthly check-in will tell you if your next pay stub does not show the change.'
        )}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button href={change} size="sm">
          Change this decision
        </Button>
        <Button href="/plan" size="sm" variant="primary">
          See your plan
        </Button>
      </div>
    </Card>
  );
}
