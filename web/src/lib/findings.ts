import type { CheckInDetail, Finding, FindingAction } from './api/types';

/*
 * The check-in screen's done / dismiss / undo, as a pure reducer over the
 * check-in the API returned. `useUpdateFinding` runs it on the cached
 * check-in so a click shows at once (an optimistic PATCH), and runs
 * `restore` to put a finding back when the server refuses. It mirrors what
 * the server writes (spec 015 rules 13 and 18): the finding's action and
 * time, the handled count, and the check-in's status.
 */

/** The parts of a check-in the reducer reads and writes. */
export type FindingsState = Pick<
  CheckInDetail,
  'findings' | 'finding_count' | 'handled_count' | 'status' | 'completed_at'
>;

export type FindingsAction =
  | { type: 'done' | 'dismiss' | 'undo'; findingId: string; at: string }
  | {
      type: 'restore';
      findingId: string;
      userAction: FindingAction | null;
      at: string | null;
      /** The check-in's `completed_at` before the change being rolled back. */
      completedAt: string | null;
    };

/** The `user_action` a screen action sends in its PATCH. */
export function userActionOf(type: 'done' | 'dismiss' | 'undo'): FindingAction | null {
  return type === 'done' ? 'done' : type === 'dismiss' ? 'dismissed' : null;
}

function nextFinding(finding: Finding, action: FindingsAction): Finding {
  if (action.type === 'restore') {
    return { ...finding, user_action: action.userAction, user_action_at: action.at };
  }
  const userAction = userActionOf(action.type);
  // The same action again changes nothing (rule 18): the first time stays.
  if (finding.user_action === userAction) return finding;
  return {
    ...finding,
    user_action: userAction,
    user_action_at: userAction === null ? null : action.at,
  };
}

export function findingsReducer<S extends FindingsState>(state: S, action: FindingsAction): S {
  const index = state.findings.findIndex((f) => f.id === action.findingId);
  const current = state.findings[index];
  if (current === undefined) return state;
  const changed = nextFinding(current, action);
  if (changed === current) return state;

  const findings = state.findings.map((f, i) => (i === index ? changed : f));
  const handled = findings.filter((f) => f.user_action !== null).length;
  // Rule 13: completed when there is at least one finding and all are handled.
  const complete = findings.length > 0 && handled === findings.length;
  let completedAt: string | null = null;
  if (complete) {
    completedAt =
      state.status === 'completed'
        ? state.completed_at
        : action.type === 'restore'
          ? action.completedAt
          : action.at;
  }
  return {
    ...state,
    findings,
    finding_count: findings.length,
    handled_count: handled,
    status: complete ? 'completed' : 'open',
    completed_at: completedAt,
  };
}
