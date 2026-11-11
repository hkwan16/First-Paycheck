import { describe, expect, it } from 'vitest';
import type { CashFlow } from '@/lib/api/types';
import {
  CASHFLOW_RESULTS,
  dynamicCashflow,
  emptyCashflow,
  sampleCashflow,
  sandboxCashflow,
  type CashflowResultName,
} from './cashflow';
import { novemberCashflow } from './checkins';

/*
 * The hand-written cash-flow fixtures carry a diagram that
 * make-cashflow-results.py computed with the API's code from the same
 * numbers. If a fixture's totals change without the script, its diagram
 * would draw another month: this fails first.
 */
const HAND_WRITTEN: [CashflowResultName, () => CashFlow][] = [
  ['sample', () => sampleCashflow()],
  ['sandbox', sandboxCashflow],
  ['dynamic', dynamicCashflow],
  ['november', novemberCashflow],
  ['empty', () => emptyCashflow('2026-09-01', '2026-09-30')],
];

describe('cash-flow fixtures', () => {
  it.each(HAND_WRITTEN)('%s matches what the API computes for it', (name, make) => {
    const flow = make();
    const computed = CASHFLOW_RESULTS[name];
    expect(flow.withholding).toEqual(computed.withholding);
    expect(flow.spending).toMatchObject(computed.spending);
    expect(flow.diagram).toEqual(computed.diagram);
  });
});
