import type { RecurringCadence, RecurringCharge } from '@/lib/api/types';
import type { Tone } from '@/lib/design/tone';

export interface RecurringBadgeView {
  tone: Tone;
  text: string;
}

/**
 * The detector's status (spec 009 rules 12-14) as a badge: a new charge or a
 * changed price needs a look (warning), a stopped one is off, an active one
 * is just there (neutral).
 */
export function recurringBadge(charge: RecurringCharge): RecurringBadgeView {
  switch (charge.status) {
    case 'new':
      return { tone: 'warning', text: 'New' };
    case 'changed':
      return { tone: 'warning', text: 'Price changed' };
    case 'stopped':
      return { tone: 'off', text: 'Stopped' };
    case 'active':
      return { tone: 'neutral', text: 'Active' };
  }
}

/** What the person said about the charge (spec 009 rule 17), or null for nothing yet. */
export function userStatusText(charge: RecurringCharge): string | null {
  switch (charge.user_status) {
    case 'ignored':
      return 'Not recurring';
    case 'confirmed':
      return 'You confirmed it';
    case 'cancelled':
      return 'You cancelled it';
    default:
      return null;
  }
}

const CADENCE: Record<RecurringCadence, string> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  yearly: 'Yearly',
};

export const cadenceLabel = (cadence: RecurringCadence) => CADENCE[cadence];

/** The longest display name the API accepts (`RecurringPatch.merchant_clean`). */
export const MAX_NAME = 100;

/** Why a new name would be refused, checked the way the API checks it; null when fine. */
export function renameError(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'Enter a name.';
  if (trimmed.length > MAX_NAME) return `Use ${MAX_NAME} characters or fewer.`;
  return null;
}
