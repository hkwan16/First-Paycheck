import { useMutation, useQueryClient } from '@tanstack/react-query';
import { $api, fetchClient } from '../client';
import { queryKeys } from '../keys';
import { unwrap } from './request';

/**
 * `GET /decisions/{id}/explanation`: the decision's latest explanation,
 * verified or the fallback. A 404 `not_found` means none has been written yet.
 */
export function useExplanation(decisionId: string) {
  return $api.useQuery(
    'get',
    '/decisions/{decision_id}/explanation',
    { params: { path: { decision_id: decisionId } } },
    { retry: false },
  );
}

export interface ExplainVariables {
  decisionId: string;
  /** Write a new explanation even when a verified one exists ("Try again"). */
  force?: boolean;
}

/**
 * `POST /explain`. The API drafts, verifies, retries once and falls back
 * before it answers (spec 008 rule 15), so the response is the final row:
 * it replaces what `useExplanation` shows. A 503 `llm_unavailable` means no
 * model is configured on this API.
 */
export function useExplain() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ decisionId, force = false }: ExplainVariables) =>
      unwrap(fetchClient.POST('/explain', { body: { decision_id: decisionId, force } })),
    // Setting data also clears a stored 404, so the read shows the new row.
    onSuccess: (explanation) =>
      queryClient.setQueryData(queryKeys.explanation(explanation.decision_id), explanation),
  });
}
