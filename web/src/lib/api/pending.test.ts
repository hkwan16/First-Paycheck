import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useDecisions, useSpendingSummary } from './pending';

describe('pending routes', () => {
  it('have no data until their routes exist, so screens show empty or skeleton states', () => {
    expect(renderHook(() => useSpendingSummary()).result.current).toBeUndefined();
    expect(renderHook(() => useDecisions()).result.current).toBeUndefined();
  });
});
