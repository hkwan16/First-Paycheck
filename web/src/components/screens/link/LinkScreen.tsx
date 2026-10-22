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
 * exists: Confirm when a document is waiting, otherwise Spending.
 */
export function LinkScreen({ showSandboxLink = features.e2e }: LinkScreenProps) {
  const accounts = useAccounts().data ?? [];
  const firstDocument = newestReviewable(useDocuments().data);

  let next: StepFooterProps['next'];
  if (accounts.length === 0) {
    next = { label: 'Continue to spending', disabled: true };
  } else if (firstDocument) {
    next = { label: 'Review extracted fields', href: confirmRoute(firstDocument.id) };
  } else {
    next = { label: 'Continue to spending', href: '/setup/spending' };
  }

  return (
    <>
      <PageTitle
        title="Link your accounts and add your documents"
        lead="Both feed one pipeline. Nothing here is sent to an AI model; only the redacted document pages are, on the next step."
      />
      <CardErrorBoundary title="Bank accounts">
        <AccountsCard showSandboxLink={showSandboxLink} />
      </CardErrorBoundary>
      <CardErrorBoundary title="Documents">
        <DocumentsCard />
      </CardErrorBoundary>
      <StepFooter
        next={next}
        status={accounts.length === 0 ? 'Link an account to continue' : undefined}
      />
    </>
  );
}
