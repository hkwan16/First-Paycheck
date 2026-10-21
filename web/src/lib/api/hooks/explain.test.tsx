import { act, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DECISION_V1_ID, EXPLANATION_ID, sampleExplanation } from '@/test/fixtures/decisions';
import { db, savedDecision } from '@/test/msw/db';
import { server } from '@/test/msw/server';
import { renderHookWithClient } from '@/test/render';
import { useExplain, useExplanation } from './explain';

/** Each `POST /explain` body, in order. */
function explainBodies() {
  const bodies: unknown[] = [];
  server.events.on('request:start', async ({ request }) => {
    if (new URL(request.url).pathname === '/explain') bodies.push(await request.clone().json());
  });
  return bodies;
}

afterEach(() => server.events.removeAllListeners());

describe('useExplanation', () => {
  it("reads the decision's latest explanation", async () => {
    savedDecision();
    const { result } = renderHookWithClient(() => useExplanation(DECISION_V1_ID));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(sampleExplanation());
  });

  it('answers a decision with no explanation yet with not_found, without retrying', async () => {
    savedDecision();
    db.explanations = new Map();
    const { result } = renderHookWithClient(() => useExplanation(DECISION_V1_ID));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({
      error: { code: 'not_found', message: 'This decision has no explanation yet' },
    });
  });
});

describe('useExplain', () => {
  it('writes the first explanation and puts it where useExplanation reads it', async () => {
    savedDecision();
    db.explanations = new Map();
    const bodies = explainBodies();
    const { result } = renderHookWithClient(() => ({
      explanation: useExplanation(DECISION_V1_ID),
      explain: useExplain(),
    }));
    await waitFor(() => expect(result.current.explanation.isError).toBe(true));

    act(() => result.current.explain.mutate({ decisionId: DECISION_V1_ID }));
    await waitFor(() => expect(result.current.explain.isSuccess).toBe(true));
    expect(bodies).toEqual([{ decision_id: DECISION_V1_ID, force: false }]);
    expect(result.current.explanation.data).toMatchObject({ verified: true, attempt: 1 });
    expect(result.current.explanation.error).toBeNull();
  });

  it('returns the stored verified explanation unless forced', async () => {
    savedDecision();
    const { result } = renderHookWithClient(() => useExplain());
    act(() => result.current.mutate({ decisionId: DECISION_V1_ID }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.id).toBe(EXPLANATION_ID);
  });

  it('writes a new one with force, and shows a fallback when both drafts fail', async () => {
    savedDecision();
    db.explainOutcomes = ['fallback'];
    const bodies = explainBodies();
    const { result } = renderHookWithClient(() => ({
      explanation: useExplanation(DECISION_V1_ID),
      explain: useExplain(),
    }));
    await waitFor(() => expect(result.current.explanation.isSuccess).toBe(true));

    act(() => result.current.explain.mutate({ decisionId: DECISION_V1_ID, force: true }));
    await waitFor(() => expect(result.current.explain.isSuccess).toBe(true));
    expect(bodies).toEqual([{ decision_id: DECISION_V1_ID, force: true }]);
    expect(result.current.explanation.data).toMatchObject({
      fallback: true,
      verified: false,
      attempt: 3,
      retries: 1,
    });
    expect(result.current.explanation.data?.id).not.toBe(EXPLANATION_ID);
  });

  it('reports 503 llm_unavailable when no model is configured', async () => {
    savedDecision();
    db.explanations = new Map();
    db.llmConfigured = false;
    const { result } = renderHookWithClient(() => useExplain());
    act(() => result.current.mutate({ decisionId: DECISION_V1_ID }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ error: { code: 'llm_unavailable' } });
  });
});
