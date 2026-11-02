'use client';

import { PageTitle } from '@/components/chrome/PageTitle';
import { StepFooter, type StepFooterProps } from '@/components/chrome/StepFooter';
import { CardErrorBoundary } from '@/components/ui/CardErrorBoundary';
import { newestReviewable, useAccounts, useDocuments } from '@/lib/api/hooks';
import { features } from '@/lib/features';
import { confirmRoute } from '@/lib/routes';
import { AccountsCard } from './AccountsCard';
import { DocumentsCard } from './DocumentsCard';

export interface LinkScreenProps {
  /** The "Link sandbox bank (test)" button; on under the `e2e` feature flag. */
  showSandboxLink?: boolean;
}

/**
 * Setup step 1, from docs/mockup/Link.dc.html: link bank accounts and set
 * their roles, then add documents. The next step opens once an account
 * exists: Confirm when a document is waiting, otherwise Spending. Until the
 * accounts have loaded it is held without asking for an account (issue 196).
 */
export function LinkScreen({ showSandboxLink = features.e2e }: LinkScreenProps) {
  const accounts = useAccounts();
  const firstDocument = newestReviewable(useDocuments().data);
  const noAccounts = accounts.isSuccess && accounts.data.length === 0;

  let next: StepFooterProps['next'];
  if (!accounts.isSuccess || noAccounts) {
    next = { label: 'Continue to spending', disabled: true };
  } else if (firstDocument) {
    next = { label: 'Check what we read', href: confirmRoute(firstDocument.id) };
  } else {
    next = { label: 'Continue to spending', href: '/setup/spending' };
  }

  return (
    <>
      <PageTitle
        title="Link your accounts and add your documents"
        lead="Your bank shows where your money goes. Your pay stub shows what comes out of each paycheck."
      />
      <CardErrorBoundary title="Bank accounts">
        <AccountsCard showSandboxLink={showSandboxLink} />
      </CardErrorBoundary>
      <CardErrorBoundary title="Documents">
        <DocumentsCard />
      </CardErrorBoundary>
      <StepFooter next={next} status={noAccounts ? 'Link an account to continue' : undefined} />
    </>
  );
}
