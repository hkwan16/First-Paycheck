import type { Route } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { PlanIcon, QuestionIcon, TrendIcon } from '@/components/icons';
import { cn } from '@/lib/cn';
import type { SetupProgress, SetupStep } from '@/lib/setup-progress';
import { NavStep } from './NavStep';

export type NavKey = SetupStep | 'why' | 'plan' | 'checkIn';

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
  { key: 'decisions', label: 'Decisions', step: 4, href: '/setup/decisions' },
];

const PLAN: readonly NavItem[] = [
  { key: 'why', label: 'Why this decision', step: <QuestionIcon /> },
  { key: 'plan', label: 'Plan and calendar', step: <PlanIcon />, href: '/plan' },
  { key: 'checkIn', label: 'Monthly check-in', step: <TrendIcon /> },
];

const PATHS: readonly [RegExp, NavKey][] = [
  [/^\/setup\/link$/, 'link'],
  [/^\/setup\/confirm(?:\/[^/]+)?$/, 'confirm'],
  [/^\/setup\/spending$/, 'spending'],
  [/^\/setup\/decisions$/, 'decisions'],
  [/^\/why(?:\/[^/]+)?$/, 'why'],
  [/^\/plan$/, 'plan'],
  [/^\/check-in\/[^/]+$/, 'checkIn'],
];

/** Which nav item a pathname belongs to. */
export function navKeyForPath(pathname: string): NavKey | undefined {
  return PATHS.find(([pattern]) => pattern.test(pathname))?.[1];
}

export interface SideNavProps {
  current?: NavKey;
  /** Done marks from lib/setup-progress. */
  done?: Partial<SetupProgress>;
  /** Hrefs for id-bound screens (latest document, decision, check-in) or overrides. */
  hrefs?: Partial<Record<NavKey, Route>>;
}

const itemClasses = cn(
  'flex min-h-11 items-center gap-2.5 rounded-control px-3 py-2 text-control font-medium text-ink-2 no-underline',
);

function Item({
  item,
  current,
  done,
  href,
}: {
  item: NavItem;
  current: boolean;
  done: boolean;
  href: Route | undefined;
}) {
  const content = (
    <>
      <NavStep done={done}>{item.step}</NavStep>
      {item.label}
      {done && <span className="sr-only">, done</span>}
    </>
  );
  return (
    <li>
      {href ? (
        <Link
          href={href}
          aria-current={current ? 'page' : undefined}
          className={cn(
            itemClasses,
            'hover:bg-ink/5 hover:text-ink',
            'aria-[current=page]:bg-surface aria-[current=page]:text-ink aria-[current=page]:shadow-raised',
          )}
        >
          {content}
        </Link>
      ) : (
        <span aria-disabled="true" className={cn(itemClasses, 'text-ink-3')}>
          {content}
        </span>
      )}
    </li>
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
  return (
    <>
      <div className="mx-3 mt-4 mb-1.5 text-micro font-semibold text-ink-3 uppercase first:mt-1 max-nav:w-full">
        {title}
      </div>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0 max-nav:flex-row max-nav:flex-wrap">
        {items.map((item) => (
          <Item
            key={item.key}
            item={item}
            current={props.current === item.key}
            done={Boolean(props.done?.[item.key as SetupStep])}
            href={props.hrefs?.[item.key] ?? item.href}
          />
        ))}
      </ul>
    </>
  );
}

/** From the mockup's `.nav`: setup steps, then the plan screens. */
export function SideNav(props: SideNavProps) {
  return (
    <nav aria-label="Setup steps">
      <Group title="Setup" items={SETUP} props={props} />
      <Group title="Your plan" items={PLAN} props={props} />
    </nav>
  );
}
