import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { fetchClient } from '../client';
import { queryKeys } from '../keys';
import type { paths } from '../schema';
import { useDebouncedValue } from './debounce';
import { unwrap } from './request';

/** How long the inputs must stay still before the calculator is asked. */
export const CALC_DEBOUNCE_MS = 150;

/** The calculator routes: stateless `POST /calc/*`, which save nothing. */
export type CalcPath = Extract<keyof paths, `/calc/${string}`>;

type CalcOperation<P extends CalcPath> = paths[P]['post'];
export type CalcInput<P extends CalcPath> =
  CalcOperation<P>['requestBody']['content']['application/json'];
export type CalcResult<P extends CalcPath> =
  CalcOperation<P>['responses'][200]['content']['application/json'];

export interface CalcState<P extends CalcPath> {
  /** The latest result; while new inputs load, the previous one stays. */
  data: CalcResult<P> | undefined;
  /**
   * The inputs `data` was calculated from; null while there is no result of
   * its own yet (none at all, or the previous one kept on screen).
   */
  inputs: CalcInput<P> | null;
  error: unknown;
  isError: boolean;
  /** Waiting for the inputs to settle, or for the calculator: mark the result `aria-busy`. */
  isBusy: boolean;
  /** `data` is the result for exactly the inputs on screen, so it can be saved. */
  isCurrent: boolean;
}

/**
 * A calculator result for `inputs`, as a query: the API computes, the client
 * shows. Changes are debounced by 150 ms (a dragged slider sends one
 * request), the last result stays on screen while the next loads, and a
 * result never goes stale for the same inputs (the calculator is pure).
 * `null` inputs send nothing.
 */
export function useCalc<P extends CalcPath>(path: P, inputs: CalcInput<P> | null): CalcState<P> {
  // Debounce the serialized body: equal inputs built anew each render stay one value.
  const typed = inputs === null ? null : JSON.stringify(inputs);
  const settledText = useDebouncedValue(typed, CALC_DEBOUNCE_MS);
  const settled = useMemo(
    () => (settledText === null ? null : (JSON.parse(settledText) as CalcInput<P>)),
    [settledText],
  );

  // A client that keeps all data 'static' (the sample screens' seeded client)
  // keeps it here too: any number, even Infinity, makes every render ask the
  // clock how old the result is, and the sample pages render without a clock.
  const staticClient = useQueryClient().getDefaultOptions().queries?.staleTime === 'static';

  const query = useQuery({
    queryKey: queryKeys.calc(path, settled),
    queryFn: ({ signal }) =>
      unwrap<CalcResult<P>>(
        // One calculator route today; the cast spans the union when there are more.
        fetchClient.POST(path as CalcPath, { body: settled as CalcInput<CalcPath>, signal }),
      ),
    enabled: settled !== null,
    staleTime: staticClient ? 'static' : Infinity,
    placeholderData: keepPreviousData,
    // A refused input (422) is an answer, not a blip.
    retry: false,
  });

  const settling = typed !== settledText;
  // Fresh: the data is this query's own, not the previous result kept on screen.
  const fresh = query.isSuccess && !query.isPlaceholderData;
  return {
    data: query.data,
    inputs: fresh ? settled : null,
    error: query.error,
    isError: query.isError,
    isBusy: settling || query.isFetching,
    isCurrent: fresh && !settling && !query.isFetching,
  };
}
