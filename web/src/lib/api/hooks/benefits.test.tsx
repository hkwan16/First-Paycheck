import { waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { sampleBenefitsPlans } from '@/test/fixtures/planning';
import { benefitsConfirmed } from '@/test/msw/planning-handlers';
import { renderHookWithClient } from '@/test/render';
import { useBenefitsPlans } from './benefits';

describe('useBenefitsPlans', () => {
  it('is empty before a benefits summary is confirmed', async () => {
    const { result } = renderHookWithClient(() => useBenefitsPlans());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });

  it('lists the confirmed plans in the order the API gives', async () => {
    benefitsConfirmed();
    const { result } = renderHookWithClient(() => useBenefitsPlans());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(sampleBenefitsPlans);
  });
});
