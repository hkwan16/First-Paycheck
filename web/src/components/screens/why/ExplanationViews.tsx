import type { Route } from 'next';
import type { ReactNode } from 'react';
import { AlertIcon, CheckIcon, WhatIfIcon } from '@/components/icons';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { KV, KVList } from '@/components/ui/KV';
import type { CalendarEvent, Explanation } from '@/lib/api/types';
import { formatDate, formatDateTime } from '@/lib/dates';

/*
 * The two layouts of docs/mockup/Why.dc.html. Verified: the AI's explanation,
 * which plain code checked against the calculator before it reached the API's
 * response. Fallback: the checks failed (or the model could not answer), so
 * the calculator's own result is shown instead. Either can be stale: written
 * from figures that have changed since (spec 008 rules 19a and 19b), which
 * the status says instead of calling it verified.
 */

/** Why a stale explanation may be wrong now (spec 008 rule 19b). */
export const STALE_TEXT =
  'It was checked against figures that have changed since, so it may no longer be right.';

/** The explanation's paragraphs (the API separates them with a blank line). */
const paragraphs = (text: string) =>
  text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);

/** From the mockup's `.status` boxes: a white box with a small caps label over the value. */
function Check({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-control bg-surface px-3.5 py-3 shadow-raised">
      <div className="text-tiny font-semibold tracking-[0.02em] text-ink-3 uppercase">{label}</div>
      <div className="mt-0.5 font-semibold tabular-nums">{value}</div>
    </div>
  );
}

const retriesText = (count: number) => (count === 1 ? '1 retry' : `${count} retries`);

function Checks({ explanation }: { explanation: Explanation }) {
  const { numbers_checked, numbers_unmatched, citations_checked, citations_unknown } =
    explanation.verification;
  // Counting the checks the API reports, not computing a figure.
  const matched = numbers_checked - numbers_unmatched.length;
  const resolved = citations_checked - citations_unknown.length;
  return (
    <>
      <Check
        label="Numbers checked"
        value={`${matched} of ${numbers_checked} match the calculator`}
      />
      <Check label="Citations" value={`${resolved} of ${citations_checked} resolve to a source`} />
    </>
  );
}

function StatusCard({
  tint,
  badge,
  meta,
  children,
}: {
  tint: 'confirmed' | 'warning';
  badge: ReactNode;
  meta: string;
  children: ReactNode;
}) {
  return (
    <Card tint={tint} aria-label="Verification status" gap={14}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {badge}
        <span className="text-tiny text-ink-3">{meta}</span>
      </div>
      {children}
    </Card>
  );
}

const STATUS_GRID = 'grid grid-cols-3 gap-3 max-nav:grid-cols-1';

export function VerifiedStatus({ explanation }: { explanation: Explanation }) {
  return (
    <StatusCard
      tint="confirmed"
      badge={
        <Badge tone="confirmed" solid icon={<CheckIcon />}>
          Verified against calculator
        </Badge>
      }
      meta={`Explanation prompt ${explanation.prompt_version} · checked ${formatDateTime(explanation.created_at)}`}
    >
      <div className={STATUS_GRID}>
        <Checks explanation={explanation} />
        <Check label="Retries" value={String(explanation.retries)} />
      </div>
    </StatusCard>
  );
}

/**
 * A verified explanation written from figures that have changed since: the
 * same checks, which held for those figures, under a warning instead of
 * "Verified", and `children` (the way to write it again).
 */
export function StaleStatus({
  explanation,
  children,
}: {
  explanation: Explanation;
  children: ReactNode;
}) {
  return (
    <StatusCard
      tint="warning"
      badge={
        <Badge tone="warning" solid icon={<AlertIcon size={12} strokeWidth={1.4} />}>
          Out of date
        </Badge>
      }
      meta={`Explanation prompt ${explanation.prompt_version} · checked ${formatDateTime(explanation.created_at)}`}
    >
      <p className="m-0 text-small text-ink-3">
        {STALE_TEXT} A newer pay stub, a benefits summary or a newer way of writing explanations
        came after it. Write it again to explain this decision from what you have confirmed now.
      </p>
      <div className={STATUS_GRID}>
        <Checks explanation={explanation} />
        <Check label="Retries" value={String(explanation.retries)} />
      </div>
      {children}
    </StatusCard>
  );
}

export function FallbackStatus({ explanation }: { explanation: Explanation }) {
  const retried = explanation.retries > 0;
  return (
    <StatusCard
      tint="warning"
      badge={
        <Badge tone="warning" solid icon={<AlertIcon size={12} strokeWidth={1.4} />}>
          Could not verify the explanation
        </Badge>
      }
      meta={`${explanation.prompt_version} · ${retriesText(explanation.retries)} · ${formatDateTime(explanation.created_at)}`}
    >
      <div className={STATUS_GRID}>
        <Check label="Retries" value={String(explanation.retries)} />
        <Check label="Citations" value={`${explanation.citations.length} resolve to a source`} />
        <Check label="Shown instead" value="Plain calculator result" />
      </div>
      <p className="m-0 text-small text-ink-3">
        {retried
          ? "The AI's explanation did not match the calculator after one retry, so it is withheld and you see the calculator's own output below."
          : "The AI could not write an explanation this time, so you see the calculator's own output below."}{' '}
        Nothing in it came from a language model.
        {explanation.stale && ' It was also written from figures that have changed since.'}
      </p>
    </StatusCard>
  );
}

/** The verified explanation's main column: the concept, its numbers and what-ifs. */
export function VerifiedBody({
  explanation,
  version,
}: {
  explanation: Explanation;
  version: number | null;
}) {
  const unmatched = new Set(explanation.verification.numbers_unmatched);
  return (
    <>
      <Card aria-labelledby="concept-title" gap={14}>
        <h2 id="concept-title" className="m-0">
          The concept
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
              <KV
                key={index}
                label={claim.label}
                value={claim.value}
                verified={!unmatched.has(claim.value)}
              />
            ))}
          </KVList>
          <p className="m-0 text-tiny text-ink-3">
            Each &ldquo;=&rdquo; means the verifier found this exact figure in the calculator&apos;s
            output{version === null ? '' : ` for decision v${version}`}.
          </p>
        </Card>
      )}

      {explanation.what_ifs.length > 0 && (
        <Card aria-labelledby="change-title" gap={14}>
          <h2 id="change-title" className="m-0">
            What would change the answer
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
 * and the way back to its calculator's step (`rerun`).
 */
export function NextSteps({ event, rerun }: { event: CalendarEvent | undefined; rerun: Route }) {
  return (
    <Card aria-labelledby="next-title" gap={14}>
      <h2 id="next-title" className="m-0">
        What happens next
      </h2>
      <p className="m-0 text-small text-ink-3">
        {event ? (
          <>
            On {formatDate(event.due_at)}: {event.title}. Your monthly check-in compares that pay
            stub with this decision and tells you if the change did not take.
          </>
        ) : (
          'Your monthly check-in compares your next pay stub with this decision and tells you if the change did not take.'
        )}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button href={rerun} size="sm">
          Re-run the calculator
        </Button>
        <Button href="/plan" size="sm" variant="primary">
          See the plan
        </Button>
      </div>
    </Card>
  );
}
