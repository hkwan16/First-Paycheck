'use client';

import { useId, type ReactNode } from 'react';
import {
  ArrowSmallIcon,
  CalendarSmallIcon,
  ChartIcon,
  CheckIcon,
  ClockIcon,
  CloseIcon,
  GrowthIcon,
  LinesIcon,
  WarningCircleIcon,
} from '@/components/icons';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { IconTile } from '@/components/ui/IconTile';
import type { UpdateFindingVariables } from '@/lib/api/hooks';
import type { Finding, FindingKind, FindingSeverity } from '@/lib/api/types';
import { affectsView, findingTone, KIND_LABELS } from './checkin-format';
import { FindingText } from './FindingText';

const KIND_ICONS: Record<FindingKind, ReactNode> = {
  election_mismatch: <WarningCircleIcon />,
  goal_off_pace: <ChartIcon />,
  recurring_new: <ClockIcon />,
  recurring_changed: <ClockIcon />,
  recurring_stopped: <ClockIcon />,
  pay_change: <GrowthIcon size={18} />,
  deduction_change: <LinesIcon size={18} />,
  upcoming_deadline: <CalendarSmallIcon />,
};

const SEVERITY_WORDS: Record<FindingSeverity, string> = {
  alert: 'Needs action',
  warning: 'Worth a look',
  info: 'For your information',
};

export interface FindingRowProps {
  finding: Finding;
  /** Mark it done or dismissed, or undo that; `title` is the row's title as shown. */
  onAction: (variables: UpdateFindingVariables, title: string) => void;
  /** Called with this row's action button (Done, or Undo once handled) and which it is. */
  actionRef: (element: HTMLButtonElement | null, handled: boolean) => void;
}

/**
 * One finding, from the mockup's `.finding`: a severity tile, the kind and
 * what it means for the plan, the part of the plan it affects, and Done and
 * Dismiss, which become Undo once handled.
 */
export function FindingRow({ finding, onAction, actionRef }: FindingRowProps) {
  const titleId = useId();
  const tone = findingTone(finding);
  const affects = affectsView(finding.payload.affects ?? null);
  const handled = finding.user_action !== null;

  const act = (type: UpdateFindingVariables['type']) =>
    onAction(
      { findingId: finding.id, type },
      document.getElementById(titleId)?.textContent ?? KIND_LABELS[finding.kind],
    );

  let glyph = KIND_ICONS[finding.kind];
  if (finding.user_action === 'done') glyph = <CheckIcon size={18} strokeWidth={1.2} />;
  if (finding.user_action === 'dismissed') glyph = <CloseIcon />;

  return (
    <li
      aria-labelledby={titleId}
      className="grid grid-cols-[36px_minmax(0,1fr)] gap-x-3.5 gap-y-1 border-t border-line py-4 first:border-t-0 first:pt-0 last:pb-0"
    >
      <IconTile tone={tone} muted={handled}>
        {glyph}
      </IconTile>
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={tone}>{KIND_LABELS[finding.kind]}</Badge>
          <span className="sr-only">{SEVERITY_WORDS[finding.severity]}.</span>
          {finding.user_action === 'done' && <Badge tone="confirmed">Done</Badge>}
          {finding.user_action === 'dismissed' && <Badge>Dismissed</Badge>}
        </div>
        <FindingText finding={finding} titleId={titleId} />
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {affects && (
            <Badge tone={affects.tone} href={affects.href}>
              Affects: {affects.label}
              <ArrowSmallIcon />
            </Badge>
          )}
          <div className="flex gap-2">
            {handled ? (
              <Button size="sm" ref={(el) => actionRef(el, true)} onClick={() => act('undo')}>
                Undo
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  ref={(el) => actionRef(el, false)}
                  onClick={() => act('done')}
                >
                  Done
                </Button>
                <Button size="sm" onClick={() => act('dismiss')}>
                  Dismiss
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}
