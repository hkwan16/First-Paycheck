import type { Route } from 'next';
import type { CalculatorKind, CheckInSummary } from './api/types';
import { safeNextPath } from './auth/next-path';
import { calculatorIdOf } from './decisions';
import { firstLiveStep, lastLiveStep } from './decision-steps';
import { features, type CalculatorId } from './features';

/*
 * Builders for the id-bound screens. Next's typed `Route` accepts a dynamic
 * segment only as a string literal at the call site, so links built from API
 * ids go through these functions: one place that knows the URL shape and
 * encodes the id as a single segment.
 */

function segment(id: string): string {
  if (id === '') throw new RangeError('A route id must not be empty');
  return encodeURIComponent(id);
}

export const confirmRoute = (documentId: string) =>
  `/setup/confirm/${segment(documentId)}` as Route;

export const whyRoute = (decisionId: string) => `/why/${segment(decisionId)}` as Route;

export const checkInRoute = (checkInId: string) => `/check-in/${segment(checkInId)}` as Route;

/**
 * Where the nav's "Monthly check-in" goes: the newest check-in still open
 * (the list is newest first), else the list of check-ins.
 */
export function checkInNavHref(checkIns: readonly CheckInSummary[] | undefined): Route {
  const open = checkIns?.find((checkIn) => checkIn.status === 'open');
  return open ? checkInRoute(open.id) : '/check-in';
}

/**
 * The old one-page Decisions address. It has no page: the proxy sends it to
 * the entry step (spec 018 rule 3).
 */
export const DECISIONS_PATH = '/setup/decisions';

/** One page per calculator (spec 018 rule 1). The slugs are stable: people bookmark them. */
const DECISION_STEP_ROUTES = {
  emergency_fund: '/setup/decisions/emergency-fund',
  '401k_match': '/setup/decisions/401k',
  health_plan: '/setup/decisions/health-plan',
  w4: '/setup/decisions/w4',
} as const satisfies Record<CalculatorId, Route>;

/** A calculator's step, by its feature flag id. */
export const decisionStepRoute = (calculator: CalculatorId): Route =>
  DECISION_STEP_ROUTES[calculator];

/** A calculator's step, by the API's name for it (`calculator_kind`). */
export const decisionKindRoute = (kind: CalculatorKind): Route =>
  decisionStepRoute(calculatorIdOf(kind));

/** Where a link to Decisions in general goes: the first live step. */
export const firstDecisionRoute = (live: readonly CalculatorId[] = features.calculators): Route =>
  decisionStepRoute(firstLiveStep(live));

/** The last live step, whose next leads to the plan. */
export const lastDecisionRoute = (live: readonly CalculatorId[] = features.calculators): Route =>
  decisionStepRoute(lastLiveStep(live));

/**
 * A calculator's step when it is live, else the entry step: for a link that
 * means "go and act on this", which a muted placeholder cannot answer.
 */
export const decisionRouteFor = (
  calculator: CalculatorId,
  live: readonly CalculatorId[] = features.calculators,
): Route => (live.includes(calculator) ? decisionStepRoute(calculator) : firstDecisionRoute(live));

export type AuthMode = 'sign-in' | 'sign-up';

export interface SignInRouteOptions {
  mode?: AuthMode;
  /** Where to return after signing in; dropped unless it is a safe relative path. */
  next?: string | null;
  /** `link`: an email link failed (expired, used, or opened in another browser). */
  error?: 'link';
  /**
   * The account was just deleted (spec 017): the page says so. Nothing of the
   * account is left to return to, so this drops every other option.
   */
  deleted?: boolean;
}

/**
 * The sign-in page. The return path keeps its slashes (`?next=/setup/link`)
 * so the URL stays readable; everything else in it is percent-encoded.
 */
export function signInRoute({
  mode = 'sign-in',
  next,
  error,
  deleted = false,
}: SignInRouteOptions = {}): Route {
  if (deleted) return '/sign-in?deleted=1' as Route;
  const params: string[] = [];
  if (mode === 'sign-up') params.push('mode=sign-up');
  const safe = safeNextPath(next);
  if (safe) params.push(`next=${encodeURIComponent(safe).replace(/%2F/g, '/')}`);
  if (error) params.push(`error=${error}`);
  return (params.length ? `/sign-in?${params.join('&')}` : '/sign-in') as Route;
}
