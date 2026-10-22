import { Fragment } from 'react';
import { Money } from '@/components/ui/Money';
import { maskLabel } from '@/lib/accounts';
import type { Holdings } from '@/lib/api/types';
import { formatDate } from '@/lib/dates';

/** A basis or gain the institution did not report (spec 015 rule 21): never shown as zero. */
function Maybe({ cents, signed = false }: { cents: number | null; signed?: boolean }) {
  return cents === null ? (
    <span className="text-tiny text-ink-3">Not reported</span>
  ) : (
    <Money cents={cents} signed={signed} />
  );
}

const cell = 'py-2 pl-3 text-right align-top';

function Amounts({
  value,
  basis,
  gain,
}: {
  value: number;
  basis: number | null;
  gain: number | null;
}) {
  return (
    <>
      <td className={cell}>
        <Money cents={value} />
      </td>
      <td className={cell}>
        <Maybe cents={basis} />
      </td>
      <td className={cell}>
        <Maybe cents={gain} signed />
      </td>
    </>
  );
}

/**
 * `GET /holdings`: each investment and retirement account's newest
 * positions with value, cost basis and gain, as the API returns them. An
 * account with several positions gets a total row, and so do several
 * accounts; a basis that is missing anywhere leaves that total's basis and
 * gain "Not reported", as the API does.
 */
export function HoldingsTable({ holdings }: { holdings: Holdings }) {
  return (
    <table aria-label="Holdings" className="w-full border-collapse text-small tabular-nums">
      <thead>
        <tr className="text-tiny font-semibold text-ink-3">
          <th scope="col" className="pb-1 text-left font-semibold">
            Holding
          </th>
          <th scope="col" className="pb-1 pl-3 text-right font-semibold">
            Value
          </th>
          <th scope="col" className="pb-1 pl-3 text-right font-semibold">
            Cost basis
          </th>
          <th scope="col" className="pb-1 pl-3 text-right font-semibold">
            Gain
          </th>
        </tr>
      </thead>
      <tbody>
        {holdings.accounts.map((account) => (
          <Fragment key={account.account_id}>
            <tr className="border-t border-line">
              <th
                scope="colgroup"
                colSpan={4}
                className="pt-2.5 pb-0.5 text-left text-tiny font-semibold text-ink-2"
              >
                {[account.name, maskLabel(account.mask)].filter(Boolean).join(' ')} · as of{' '}
                {formatDate(account.as_of)}
              </th>
            </tr>
            {account.holdings.map((position) => (
              <tr key={position.security_id}>
                <th scope="row" className="py-2 text-left align-top font-normal">
                  <span className="block font-semibold">{position.name}</span>
                  <span className="text-tiny text-ink-3">
                    {[
                      position.ticker,
                      `${position.quantity} ${position.quantity === '1' ? 'share' : 'shares'}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </th>
                <Amounts
                  value={position.value_cents}
                  basis={position.cost_basis_cents}
                  gain={position.gain_cents}
                />
              </tr>
            ))}
            {account.holdings.length > 1 && (
              <tr className="border-t border-line">
                <th scope="row" className="py-2 text-left font-semibold">
                  {account.name} total
                </th>
                <Amounts
                  value={account.value_cents}
                  basis={account.cost_basis_cents}
                  gain={account.gain_cents}
                />
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
      {holdings.accounts.length > 1 && (
        <tfoot>
          <tr className="border-t border-line font-semibold">
            <th scope="row" className="py-2 text-left">
              All accounts
            </th>
            <Amounts
              value={holdings.value_cents}
              basis={holdings.cost_basis_cents}
              gain={holdings.gain_cents}
            />
          </tr>
        </tfoot>
      )}
    </table>
  );
}
