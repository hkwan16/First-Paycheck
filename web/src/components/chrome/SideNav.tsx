import type { Route } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { PlanIcon, QuestionIcon, TrendIcon } from '@/components/icons';
import { cn } from '@/lib/cn';
import { DECISION_STEPS, STEP_TEXT } from '@/lib/decision-steps';
import { features, type CalculatorId } from '@/lib/features';
import { decisionStepRoute, firstDecisionRoute } from '@/lib/routes';
import type { ProgressKey, SetupProgress, SetupStep } from '@/lib/setup-progress';
import { NavStep } from './NavStep';

/** A nav item: a setup step, a decision step (by its calculator), or a plan screen. */
export type NavKey = SetupStep | CalculatorId | 'why' | 'plan' | 'checkIn';

const hasDoneMark = (key: NavKey): key is ProgressKey => key !== 'why' && key !== 'checkIn';

interface NavItem {
  key: NavKey;
  label: string;
  step: ReactNode;
  /** Routes without an id; id-bound screens get their href from the caller. */
  href?: Route;
}

const SETUP: readonly NavItem[] = [
  { key: 'link', label: 'Accounts and documents', step: 1, href: '/setup/link' },
  { key: 'confirm', label: 'Confirm pay stub', step: 2, href: '/setup/confirm' },
  { key: 'spending', label: 'Spending map', step: 3, href: '/setup/spending' },
  // Its href is the first live decision step (spec 018 rule 10).
  { key: 'decisions', label: 'Decisions', step: 4 },
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
  children,
}: {
  href: Route | undefined;
  current: boolean;
  className: string;
  children: ReactNode;
}) {
  return href ? (
    <Link
      href={href}
      aria-current={current ? 'page' : undefined}
      className={cn(itemClasses, linkClasses, className)}
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

/**
 * The four decision steps under Decisions (spec 018 rules 7-11): indented
 * behind a hairline, each with its own current state and done mark; one not
 * live in this build is muted and says After alpha. Under 780px they wrap
 * into a row of their own beneath the Decisions chip.
 */
function DecisionSteps({ props, live }: { props: SideNavProps; live: readonly CalculatorId[] }) {
  return (
    <ul className="m-0 mt-0.5 ml-[22px] flex list-none flex-col gap-0.5 border-l border-line p-0 pl-1.5 max-nav:flex-row max-nav:flex-wrap">
      {DECISION_STEPS.map((id) => {
        const muted = !live.includes(id);
        const done = Boolean(props.done?.[id]);
        return (
          <li key={id}>
            <ItemLink
              href={decisionStepRoute(id)}
              current={props.current === id}
              className={cn('gap-2 px-2.5 py-1 text-small', muted && 'text-ink-3')}
            >
              <NavStep size="sm" done={done}>
                <span className="size-1.5 rounded-full bg-current" />
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
  props,
}: {
  title: string;
  items: readonly NavItem[];
  props: SideNavProps;
}) {
  const live = props.calculators ?? features.calculators;
  return (
    <>
      <div className="mx-3 mt-4 mb-1.5 text-micro font-semibold text-ink-3 uppercase first:mt-1 max-nav:w-full">
        {title}
      </div>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0 max-nav:flex-row max-nav:flex-wrap">
        {items.map((item) => {
          const decisions = item.key === 'decisions';
          const done = hasDoneMark(item.key) && Boolean(props.done?.[item.key]);
          const href =
            props.hrefs?.[item.key] ?? (decisions ? firstDecisionRoute(live) : item.href);
          return (
            <li key={item.key} className={cn(decisions && 'max-nav:basis-full')}>
              <ItemLink
                href={href}
                current={props.current === item.key}
                className="gap-2.5 px-3 py-2 text-control"
              >
                <NavStep done={done}>{item.step}</NavStep>
                {item.label}
                {done && doneText}
              </ItemLink>
              {decisions && <DecisionSteps props={props} live={live} />}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** From the mockup's `.nav`: setup steps (Decisions with its four steps), then the plan screens. */
export function SideNav(props: SideNavProps) {
  return (
    <nav aria-label="Setup steps">
      <Group title="Setup" items={SETUP} props={props} />
      <Group title="Your plan" items={PLAN} props={props} />
    </nav>
  );
}
