'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowSmallIcon, LinesIcon, PlanIcon, QuestionIcon, TrendIcon } from '@/components/icons';
import { cn } from '@/lib/cn';
import { DECISION_STEPS, STEP_TEXT } from '@/lib/decision-steps';
import { features, type CalculatorId } from '@/lib/features';
import { decisionStepRoute, firstDecisionRoute } from '@/lib/routes';
import {
  SETUP_STEPS,
  setupStepsDone,
  type ProgressKey,
  type SetupProgress,
  type SetupStep,
} from '@/lib/setup-progress';
import { NavStep } from './NavStep';

/** A nav item: a setup step, a decision step (by its calculator), or a plan screen. */
export type NavKey = SetupStep | CalculatorId | 'why' | 'plan' | 'checkIn';

const hasDoneMark = (key: NavKey): key is ProgressKey => key !== 'why' && key !== 'checkIn';

const isDecisionStep = (key: NavKey): key is CalculatorId =>
  (DECISION_STEPS as readonly NavKey[]).includes(key);

interface NavItem {
  key: NavKey;
  label: string;
  step: ReactNode;
  /** Routes without an id; id-bound screens get their href from the caller. */
  href?: Route;
}

const DECISIONS_LABEL = 'Decisions';

const SETUP: readonly NavItem[] = [
  { key: 'link', label: 'Accounts and documents', step: 1, href: '/setup/link' },
  { key: 'confirm', label: 'Confirm pay stub', step: 2, href: '/setup/confirm' },
  { key: 'spending', label: 'Spending map', step: 3, href: '/setup/spending' },
  // Its href is the first live decision step (spec 018 rule 10).
  { key: 'decisions', label: DECISIONS_LABEL, step: 4 },
];

const PLAN: readonly NavItem[] = [
  { key: 'why', label: 'Why this decision', step: <QuestionIcon />, href: '/why' },
  { key: 'plan', label: 'Plan and calendar', step: <PlanIcon />, href: '/plan' },
  { key: 'checkIn', label: 'Monthly check-in', step: <TrendIcon /> },
];

const PATHS: readonly [RegExp, NavKey][] = [
  [/^\/setup\/link$/, 'link'],
  [/^\/setup\/confirm(?:\/[^/]+)?$/, 'confirm'],
  [/^\/setup\/spending$/, 'spending'],
  [/^\/why(?:\/[^/]+)?$/, 'why'],
  [/^\/plan$/, 'plan'],
  [/^\/check-in(?:\/[^/]+)?$/, 'checkIn'],
];

/** Which nav item a pathname belongs to: a decision step is its calculator. */
export function navKeyForPath(pathname: string): NavKey | undefined {
  const step = DECISION_STEPS.find((id) => decisionStepRoute(id) === pathname);
  return step ?? PATHS.find(([pattern]) => pattern.test(pathname))?.[1];
}

export interface SideNavProps {
  current?: NavKey;
  /** Done marks from lib/setup-progress: the setup steps, the decision steps and the plan. */
  done?: Partial<SetupProgress>;
  /** Hrefs for id-bound screens (latest document, decision, check-in) or overrides. */
  hrefs?: Partial<Record<NavKey, Route>>;
  /** Live calculators (`features.calculators`); the other decision steps are muted, After alpha. */
  calculators?: readonly CalculatorId[];
  /** The page's path: an open list on a phone closes when it changes (spec 018 rule 15). */
  pathname?: string;
}

const itemClasses =
  'flex min-h-11 items-center rounded-control no-underline font-medium text-ink-2';
const linkClasses = cn(
  'hover:bg-ink/5 hover:text-ink',
  'aria-[current=page]:bg-surface aria-[current=page]:text-ink aria-[current=page]:shadow-raised',
);

function ItemLink({
  href,
  current,
  className,
  onChoose,
  children,
}: {
  href: Route | undefined;
  current: boolean;
  className: string;
  onChoose: () => void;
  children: ReactNode;
}) {
  return href ? (
    <Link
      href={href}
      aria-current={current ? 'page' : undefined}
      className={cn(itemClasses, linkClasses, className)}
      onClick={onChoose}
    >
      {children}
    </Link>
  ) : (
    <span aria-disabled="true" className={cn(itemClasses, 'text-ink-3', className)}>
      {children}
    </span>
  );
}

const doneText = <span className="sr-only">, done</span>;

/** The small marker of a decision step: a dot, or a check once done. */
const stepDot = <span className="size-1.5 rounded-full bg-current" />;

interface ListProps extends SideNavProps {
  live: readonly CalculatorId[];
  /** A link in the list was chosen: the phone list closes. */
  onChoose: () => void;
}

/**
 * The four decision steps under Decisions (spec 018 rules 7-9): indented
 * behind a hairline, each with its own current state and done mark; one not
 * live in this build is muted and says After alpha.
 */
function DecisionSteps({ live, ...props }: ListProps) {
  return (
    <ul className="m-0 mt-0.5 ml-[22px] flex list-none flex-col gap-0.5 border-l border-line p-0 pl-1.5">
      {DECISION_STEPS.map((id) => {
        const muted = !live.includes(id);
        const done = Boolean(props.done?.[id]);
        return (
          <li key={id}>
            <ItemLink
              href={decisionStepRoute(id)}
              current={props.current === id}
              className={cn('gap-2 px-2.5 py-1 text-small', muted && 'text-ink-3')}
              onChoose={props.onChoose}
            >
              <NavStep size="sm" done={done}>
                {stepDot}
              </NavStep>
              <span className="flex flex-col">
                {STEP_TEXT[id].label}
                {muted && (
                  <span aria-hidden="true" className="text-tiny font-normal text-ink-3">
                    After alpha
                  </span>
                )}
              </span>
              {muted && <span className="sr-only">, After alpha</span>}
              {done && doneText}
            </ItemLink>
          </li>
        );
      })}
    </ul>
  );
}

function Group({
  title,
  items,
  ...props
}: ListProps & { title: string; items: readonly NavItem[] }) {
  return (
    <>
      <div className="mx-3 mt-4 mb-1.5 text-micro font-semibold text-ink-3 uppercase first:mt-1">
        {title}
      </div>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {items.map((item) => {
          const decisions = item.key === 'decisions';
          const done = hasDoneMark(item.key) && Boolean(props.done?.[item.key]);
          const href =
            props.hrefs?.[item.key] ?? (decisions ? firstDecisionRoute(props.live) : item.href);
          return (
            <li key={item.key}>
              <ItemLink
                href={href}
                current={props.current === item.key}
                className="gap-2.5 px-3 py-2 text-control"
                onChoose={props.onChoose}
              >
                <NavStep done={done}>{item.step}</NavStep>
                {item.label}
                {done && doneText}
              </ItemLink>
              {decisions && <DecisionSteps {...props} />}
            </li>
          );
        })}
      </ul>
    </>
  );
}

interface Location {
  label: string;
  marker: ReactNode;
  size: 'md' | 'sm';
  done: boolean;
}

/** Where the person is, for the phone control (spec 018 rule 13). */
function locationOf({ current, done }: SideNavProps): Location {
  if (current === undefined) {
    return { label: 'Setup steps', marker: <LinesIcon size={12} />, size: 'md', done: false };
  }
  const isDone = hasDoneMark(current) && Boolean(done?.[current]);
  if (isDecisionStep(current)) {
    const label = `${DECISIONS_LABEL}: ${STEP_TEXT[current].label}`;
    return { label, marker: stepDot, size: 'sm', done: isDone };
  }
  const item = [...SETUP, ...PLAN].find((candidate) => candidate.key === current)!;
  return { label: item.label, marker: item.step, size: 'md', done: isDone };
}

/**
 * From the mockup's `.nav`: setup steps (Decisions with its four steps), then
 * the plan screens. Under 780px (spec 018 rules 11-17) the same list sits
 * behind one disclosure button that names where the person is and how far
 * through setup they are; the list opens in place, pushing the page down, and
 * closes on Escape, on a link chosen and when the page changes. At 780px and
 * wider the button is not displayed and the list always shows.
 */
export function SideNav({ pathname, ...props }: SideNavProps) {
  const listId = useId();
  const controlRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // An open list belongs to the page it was opened on (React's "adjust state when a prop changes").
  const [openedOn, setOpenedOn] = useState(pathname);
  if (pathname !== openedOn) {
    setOpenedOn(pathname);
    setOpen(false);
  }

  const live = props.calculators ?? features.calculators;
  const where = locationOf(props);
  const progress = `${setupStepsDone(props.done)} of ${SETUP_STEPS.length} setup steps done`;
  const close = () => setOpen(false);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !open) return;
    close();
    controlRef.current?.focus();
  };

  return (
    <nav aria-label="Setup steps" onKeyDown={onKeyDown}>
      <button
        ref={controlRef}
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen(!open)}
        className={cn(
          itemClasses,
          'w-full cursor-pointer gap-2.5 border-0 bg-surface px-3 py-2 text-left text-control text-ink shadow-raised nav:hidden',
        )}
      >
        <NavStep size={where.size} done={where.done}>
          {where.marker}
        </NavStep>
        <span className="flex min-w-0 flex-1 flex-col">
          <span>
            {where.label}
            {where.done && doneText}
            <span className="sr-only">,</span>
          </span>
          {/* The space between the two lines in the accessible name; a flex column ignores it. */}{' '}
          <span className="text-tiny font-normal text-ink-3">{progress}</span>
        </span>
        <ArrowSmallIcon
          size={8}
          className={cn(
            'flex-none transition-[rotate] duration-(--duration-fast)',
            open ? '-rotate-90' : 'rotate-90',
          )}
        />
      </button>
      <div id={listId} className={cn('max-nav:mt-2', !open && 'max-nav:hidden')}>
        <Group title="Setup" items={SETUP} {...props} live={live} onChoose={close} />
        <Group title="Your plan" items={PLAN} {...props} live={live} onChoose={close} />
      </div>
    </nav>
  );
}
