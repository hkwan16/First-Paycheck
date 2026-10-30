import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BENEFITS_DOC_ID,
  manualEntryProposal,
  PAY_STUB_DOC_ID,
  sampleDocument,
} from '@/test/fixtures/documents';
import { db } from '@/test/msw/db';
import { benefitsWaiting } from '@/test/msw/planning-handlers';
import { renderWithProviders, screen, within } from '@/test/render';
import { ConfirmScreen } from './ConfirmScreen';
import type * as FieldFormat from './field-format';
import { confidenceBadge, splitSourceLine } from './field-format';

/*
 * A keystroke in one field changes that field only, so only its row renders
 * again: not the other rows, and not the source pane. Every row calls
 * confidenceBadge and the source pane calls splitSourceLine on each render,
 * so their calls count the renders.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('./field-format', async (importOriginal) => {
  const actual = await importOriginal<typeof FieldFormat>();
  return {
    ...actual,
    confidenceBadge: vi.fn(actual.confidenceBadge),
    splitSourceLine: vi.fn(actual.splitSourceLine),
  };
});

async function typeOneKey(documentId: string, region: string, label: string) {
  const { user } = renderWithProviders(<ConfirmScreen documentId={documentId} />);
  const card = await screen.findByRole('region', { name: region });
  const row = within(card).getByRole('group', { name: label });
  const edit = within(row).queryByRole('button', { name: `Edit ${label}` });
  if (edit) await user.click(edit);
  await user.click(within(row).getByLabelText(label));
  vi.mocked(confidenceBadge).mockClear();
  vi.mocked(splitSourceLine).mockClear();
  await user.keyboard('7');
}

describe('Confirm review renders', () => {
  it('renders only the pay stub row being typed in', async () => {
    db.documents = [sampleDocument({ status: 'manual_entry_required', status_reason: 'refused' })];
    db.proposals.set(PAY_STUB_DOC_ID, structuredClone(manualEntryProposal));
    await typeOneKey(PAY_STUB_DOC_ID, 'Pay stub fields', 'Gross pay');
    expect(confidenceBadge).toHaveBeenCalledOnce();
    expect(splitSourceLine).not.toHaveBeenCalled();
  });

  describe('benefits summary', () => {
    beforeEach(() => {
      db.documents = [];
      benefitsWaiting();
    });

    it('renders only the benefits row being typed in', async () => {
      await typeOneKey(BENEFITS_DOC_ID, 'Plans and 401(k) match', 'Plan 1: Deductible');
      expect(confidenceBadge).toHaveBeenCalledOnce();
      expect(splitSourceLine).not.toHaveBeenCalled();
    });
  });
});
