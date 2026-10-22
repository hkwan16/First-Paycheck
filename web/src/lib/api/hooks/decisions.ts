import { useMutation, useQueryClient } from '@tanstack/react-query';
import { $api, fetchClient } from '../client';
import { apiErrorCode } from '../errors';
import { invalidateAfterDecision, invalidateDecisions, queryKeys } from '../keys';
import type { CalculatorKind, Decision, DecisionSaved } from '../types';
import type { CalcPath } from './calc';

/** `GET /decisions`: each calculator's current decision and its version history. */
export function useDecisions() {
  return $api.useQuery('get', '/decisions');
}

/** `GET /decisions/{id}`: one version (current or not); another person's id is a 404. */
export function useDecision(decisionId: string) {
  return $api.useQuery(
    'get',
    '/decisions/{decision_id}',
    { params: { path: { decision_id: decisionId } } },
    // A 404 is an answer, not a blip.
    { retry: false },
  );
}

/** Inclusive due dates (`YYYY-MM-DD`) bounding a calendar read; either may be left out. */
export interface CalendarWindow {
  from?: string;
  to?: string;
}

/**
 * `GET /calendar`: upcoming checks and deadlines, soonest first, within
 * `window` when given (spec 015 rule 22). With no bounds it is the plain read
 * every screen shares.
 */
export function useCalendar({ from, to }: CalendarWindow = {}) {
  const query = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  return $api.useQuery(
    'get',
    '/calendar',
    Object.keys(query).length > 0 ? { params: { query } } : undefined,
  );
}

/** The calculator route that produces each calculator's result. */
const CALC_PATHS: Partial<Record<CalculatorKind, CalcPath>> = {
  emergency_fund: '/calc/emergency-fund',
  k401_match: '/calc/401k-match',
  health_plans: '/calc/health-plans',
  w4: '/calc/w4',
};

interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> | null };
}

/**
 * The server recomputed the result and it differs from the one sent (spec 007
 * rule 2): the numbers on screen are out of date. `fields` names what
 * differed; `error` keeps the API body so `apiErrorMessage` reads it.
 */
export class ResultMismatch extends Error {
  readonly error: ApiErrorBody['error'];
  readonly fields: string[];

  constructor(body: ApiErrorBody) {
    super(body.error.message);
    this.name = 'ResultMismatch';
    this.error = body.error;
    const fields = body.error.details?.fields;
    this.fields = Array.isArray(fields) ? fields.filter((f) => typeof f === 'string') : [];
  }
}

export interface SaveDecisionVariables {
  /** The calculator's inputs, as sent to `POST /calc/*`. */
  inputs: object;
  /** The result the person saw, as `POST /calc/*` returned it. */
  result: object;
  /** The calculator's current decision, which this one supersedes; undefined for v1. */
  current: Decision | null | undefined;
}

/**
 * `POST /decisions` for one calculator: a new version over `current` (its id
 * goes as `supersedes_id`). The server recomputes and compares. When the save
 * lands, the decisions, calendar, plan and goals are read again before the
 * mutation reports success, so the card shows the new version at once.
 *
 * Failures: a 422 `result_mismatch` throws `ResultMismatch` and recalculates
 * the calculator's results; a 409 `decision_conflict` (another tab saved
 * first) reloads the decisions; anything else is the API body.
 */
export function useSaveDecision(calculator: CalculatorKind) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ inputs, result, current }: SaveDecisionVariables) => {
      const { data, error } = await fetchClient.POST('/decisions', {
        body: {
          calculator,
          inputs: inputs as Record<string, unknown>,
          result: result as Record<string, unknown>,
          supersedes_id: current?.id ?? null,
        },
      });
      if (error !== undefined) {
        throw apiErrorCode(error) === 'result_mismatch'
          ? new ResultMismatch(error as ApiErrorBody)
          : error;
      }
      return data as DecisionSaved;
    },
    onSuccess: () => invalidateAfterDecision(queryClient),
    onError: (error) => {
      const code = apiErrorCode(error);
      if (code === 'decision_conflict') void invalidateDecisions(queryClient);
      const path = CALC_PATHS[calculator];
      if (code === 'result_mismatch' && path) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.calc(path) });
      }
    },
  });
}
