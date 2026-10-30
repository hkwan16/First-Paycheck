import { QueryClient } from '@tanstack/react-query';
import { act, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { K401MatchInput } from '@/lib/api/types';
import { sampleK401, sampleK401Inputs } from '@/test/fixtures/decisions';
import { apiUrl } from '@/test/msw/handlers';
import { server } from '@/test/msw/server';
import { renderHookWithClient } from '@/test/render';
import { queryKeys } from '../keys';
import { CALC_DEBOUNCE_MS, useCalc } from './calc';

const PATH = '/calc/401k-match';

/** The body of every calculator request, in order. */
function calcBodies() {
  const bodies: K401MatchInput[] = [];
  server.events.on('request:start', async ({ request }) => {
    if (new URL(request.url).pathname === PATH) {
      bodies.push((await request.clone().json()) as K401MatchInput);
    }
  });
  return bodies;
}

const pct = (body: K401MatchInput) => body.contribution_pct;

function renderCalc(initial: K401MatchInput | null) {
  return renderHookWithClient(
    ({ inputs }: { inputs: K401MatchInput | null }) => useCalc(PATH, inputs),
    { initialProps: { inputs: initial } },
  );
}

describe('useCalc', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => {
    vi.useRealTimers();
    server.events.removeAllListeners();
  });

  it('POSTs the inputs and returns the calculator result for exactly those inputs', async () => {
    const bodies = calcBodies();
    const { result } = renderCalc(sampleK401Inputs(4));
    await waitFor(() => expect(result.current.isCurrent).toBe(true));
    expect(result.current.data).toEqual(sampleK401(4).result);
    expect(result.current.inputs).toEqual(sampleK401Inputs(4));
    expect(result.current.isBusy).toBe(false);
    expect(bodies.map(pct)).toEqual(['4.00']);
  });

  it('waits until the inputs have been still for 150 ms, so a drag sends one request', async () => {
    const sentAt: number[] = [];
    server.events.on('request:start', ({ request }) => {
      if (new URL(request.url).pathname === PATH) sentAt.push(Date.now());
    });
    const bodies = calcBodies();
    const { result, rerender } = renderCalc(sampleK401Inputs(0));
    await waitFor(() => expect(result.current.isCurrent).toBe(true));

    // One drag across three stops: no time passes between them.
    rerender({ inputs: sampleK401Inputs(1) });
    rerender({ inputs: sampleK401Inputs(2) });
    rerender({ inputs: sampleK401Inputs(3) });
    const stoppedAt = Date.now();
    expect(result.current.isBusy).toBe(true);
    expect(bodies.map(pct)).toEqual(['0.00']);

    await act(() => vi.advanceTimersByTimeAsync(CALC_DEBOUNCE_MS));
    await waitFor(() => expect(result.current.isCurrent).toBe(true));
    expect(bodies.map(pct)).toEqual(['0.00', '3.00']);
    expect(result.current.data).toEqual(sampleK401(3).result);
    // Measured on the test clock, so a slow machine cannot make it pass or fail.
    expect(sentAt[1]! - stoppedAt).toBeGreaterThanOrEqual(CALC_DEBOUNCE_MS);
  });

  it('keeps the previous result on screen, marked busy, while the next one loads', async () => {
    const { result, rerender } = renderCalc(sampleK401Inputs(2));
    await waitFor(() => expect(result.current.isCurrent).toBe(true));

    rerender({ inputs: sampleK401Inputs(5) });
    expect(result.current.data).toEqual(sampleK401(2).result);
    expect(result.current.isBusy).toBe(true);
    expect(result.current.isCurrent).toBe(false);
    // The result belongs to the settled inputs, never to the ones still being typed.
    expect(result.current.inputs).toEqual(sampleK401Inputs(2));

    await act(() => vi.advanceTimersByTimeAsync(CALC_DEBOUNCE_MS));
    await waitFor(() => expect(result.current.data).toEqual(sampleK401(5).result));
    expect(result.current.isBusy).toBe(false);
    expect(result.current.inputs).toEqual(sampleK401Inputs(5));
  });

  it('names the inputs of the result it keeps on screen while the next one is asked for', async () => {
    const { result, rerender } = renderCalc(sampleK401Inputs(2));
    await waitFor(() => expect(result.current.isCurrent).toBe(true));
    // Hold the next answer until the test lets it go.
    let answer: () => void = () => {};
    const answered = new Promise<void>((resolve) => (answer = resolve));
    server.use(
      http.post(apiUrl(PATH), async () => {
        await answered;
        return HttpResponse.json(sampleK401(5).result);
      }),
    );

    rerender({ inputs: sampleK401Inputs(5) });
    await act(() => vi.advanceTimersByTimeAsync(CALC_DEBOUNCE_MS));
    await waitFor(() => expect(result.current.isBusy).toBe(true));
    // The request for 5% is out; the 2% result and its inputs stay together.
    expect(result.current.data).toEqual(sampleK401(2).result);
    expect(result.current.inputs).toEqual(sampleK401Inputs(2));
    expect(result.current.isCurrent).toBe(false);

    answer();
    await waitFor(() => expect(result.current.isCurrent).toBe(true));
    expect(result.current.data).toEqual(sampleK401(5).result);
    expect(result.current.inputs).toEqual(sampleK401Inputs(5));
  });

  it('never asks again for inputs it has already calculated', async () => {
    const bodies = calcBodies();
    const { result, rerender, queryClient } = renderCalc(sampleK401Inputs(2));
    await waitFor(() => expect(result.current.isCurrent).toBe(true));
    rerender({ inputs: sampleK401Inputs(6) });
    await act(() => vi.advanceTimersByTimeAsync(CALC_DEBOUNCE_MS));
    await waitFor(() => expect(result.current.data).toEqual(sampleK401(6).result));

    rerender({ inputs: sampleK401Inputs(2) });
    await act(() => vi.advanceTimersByTimeAsync(CALC_DEBOUNCE_MS));
    await waitFor(() => expect(result.current.data).toEqual(sampleK401(2).result));
    expect(bodies.map(pct)).toEqual(['2.00', '6.00']);
    const cached = queryClient.getQueryCache().find({
      queryKey: queryKeys.calc(PATH, sampleK401Inputs(2)),
    });
    expect(cached?.isStaleByTime(Infinity)).toBe(false);
  });

  it('sends nothing until there are inputs', async () => {
    const bodies = calcBodies();
    const { result, rerender } = renderCalc(null);
    await act(() => vi.advanceTimersByTimeAsync(CALC_DEBOUNCE_MS * 2));
    expect(bodies).toEqual([]);
    expect(result.current.data).toBeUndefined();
    expect(result.current.isBusy).toBe(false);

    rerender({ inputs: sampleK401Inputs(4) });
    expect(result.current.isBusy).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(CALC_DEBOUNCE_MS));
    await waitFor(() => expect(result.current.isCurrent).toBe(true));
    expect(bodies.map(pct)).toEqual(['4.00']);
  });

  it("reports the API's error, without retrying a 422", async () => {
    const bodies = calcBodies();
    server.use(
      http.post(apiUrl(PATH), () =>
        HttpResponse.json(
          {
            error: { code: 'validation_error', message: 'no federal constants for tax year 2027' },
          },
          { status: 422 },
        ),
      ),
    );
    // The app's client retries a failed read once; a refused input is an answer.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: 1, retryDelay: 0 } },
    });
    const { result } = renderHookWithClient(
      () => useCalc(PATH, { ...sampleK401Inputs(4), tax_year: 2027 }),
      { queryClient },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ error: { code: 'validation_error' } });
    expect(result.current.isCurrent).toBe(false);
    expect(bodies).toHaveLength(1);
  });
});
