'use client';

import { useId } from 'react';
import { Checkbox } from '@/components/ui/Checkbox';
import { IconTile } from '@/components/ui/IconTile';
import { Label } from '@/components/ui/Label';
import { Money } from '@/components/ui/Money';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Select } from '@/components/ui/Select';
import { useUpdateAccount } from '@/lib/api/hooks';
import { apiErrorMessage } from '@/lib/api/errors';
import type { Account } from '@/lib/api/types';
import { institutionName, maskLabel } from '@/lib/accounts';
import {
  institutionInitials,
  patchForRole,
  roleOptions,
  roleSelectName,
  roleText,
  roleValue,
  transactionCountText,
  type RoleValue,
} from './account-format';

/** Accounts people spend from show their activity; the rest show their balance. */
const SHOWS_ACTIVITY = new Set<Account['kind']>(['checking', 'credit']);

function Activity({ account }: { account: Account }) {
  if (!SHOWS_ACTIVITY.has(account.kind)) {
    return account.balance_cents === null ? (
      'No balance yet'
    ) : (
      <>
        Balance <Money cents={account.balance_cents} />
      </>
    );
  }
  return transactionCountText(account);
}

/**
 * From the mockup's account row: institution initials, name and mask, when
 * it last synced and what it holds, and the Role select. The select is
 * optimistic (useUpdateAccount); a failed save puts the old role back and
 * says why under the row. An account with no role to choose (a loan) gets no
 * picker: one checkbox, named for it, that counts it in net worth or leaves
 * it out (the select's "No role" and "Not used"), with where it stands beside
 * it (issue 265).
 */
export function AccountRow({ account }: { account: Account }) {
  const nameId = useId();
  const selectId = useId();
  const errorId = useId();
  const update = useUpdateAccount();
  const mask = maskLabel(account.mask);
  const standing = roleText(account);

  const onChange = (value: RoleValue) =>
    update.mutate({ accountId: account.id, patch: patchForRole(value) });

  return (
    <div role="group" aria-labelledby={nameId} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <IconTile tone="blue" label={institutionInitials(institutionName(account))} />
          <div className="min-w-0">
            <div className="font-semibold">
              <span id={nameId}>{account.name}</span>
              {mask && <span className="font-medium text-ink-3 tabular-nums"> {mask}</span>}
            </div>
            <div className="text-small text-ink-3">
              {account.balance_as_of ? (
                <>
                  Synced <RelativeTime value={account.balance_as_of} />
                </>
              ) : (
                'Not synced yet'
              )}{' '}
              &middot; <Activity account={account} />
            </div>
          </div>
        </div>
        {standing !== null ? (
          <div className="flex flex-wrap items-center gap-3">
            <Checkbox
              checked={account.is_active}
              onChange={(checked) => onChange(checked ? '' : 'unused')}
            >
              Count <span className="sr-only">{account.name}</span> in net worth
            </Checkbox>
            <span className="text-small text-ink-3">{standing}</span>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <Label htmlFor={selectId} className="m-0">
              Role
            </Label>
            {/* Named for its account, starting with the visible label (issue 242). */}
            <Select
              id={selectId}
              aria-label={roleSelectName(account)}
              className="w-auto min-w-40"
              value={roleValue(account)}
              aria-busy={update.isPending || undefined}
              aria-describedby={update.isError ? errorId : undefined}
              onChange={(event) => onChange(event.currentTarget.value as RoleValue)}
            >
              {roleOptions(account).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>
      {update.isError && (
        <p id={errorId} role="alert" className="m-0 text-small text-ink-2">
          Could not save the role.{' '}
          {apiErrorMessage(update.error, 'Check your connection and try again.')}
        </p>
      )}
    </div>
  );
}
