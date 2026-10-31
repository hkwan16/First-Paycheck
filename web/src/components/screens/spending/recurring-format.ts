import type { RecurringCadence, RecurringCharge } from '@/lib/api/types';
import type { Tone } from '@/lib/design/tone';

export interface RecurringBadgeView {
  tone: Tone;
  text: string;
}

/**
 * The row's one status badge (spec 009 rule 19). Once the person has marked
 * the charge it says only what they decided, in neutral: their word replaces
 * the detector's, which the check-in still reports. Unmarked, it is the
 * detector's status (rules 12-14): a new charge or a changed price needs a
 * look (warning), a stopped one is off, an active one is just there (neutral).
 */
export function recurringBadge(charge: RecurringCharge): RecurringBadgeView {
  switch (charge.user_status) {
    case 'ignored':
      return { tone: 'neutral', text: 'Not recurring' };
    case 'confirmed':
      return { tone: 'neutral', text: 'You confirmed it' };
    case 'cancelled':
      return { tone: 'neutral', text: 'You cancelled it' };
    case null:
      break;
  }
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
