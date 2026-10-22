import { $api } from '../client';

/**
 * `GET /benefits-plans`: the health plans of every confirmed benefits
 * summary, the most recently confirmed summary first, each summary's plans in
 * the order it lists them (spec 013 rule 14).
 */
export function useBenefitsPlans() {
  return $api.useQuery('get', '/benefits-plans');
}
