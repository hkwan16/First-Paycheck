import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSpendingSummary } from './pending';

describe('pending routes', () => {
  it('have no data until their routes exist, so screens show empty or skeleton states', () => {
    expect(renderHook(() => useSpendingSummary()).result.current).toBeUndefined();
  });
});
