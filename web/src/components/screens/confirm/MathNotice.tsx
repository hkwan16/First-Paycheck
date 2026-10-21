import { Money } from '@/components/ui/Money';
import { Notice } from '@/components/ui/Notice';
import type { PayStubBalance } from '@/lib/api/hooks';
import type { Gate } from './confirmReducer';

/**
 * The arithmetic gate, from the mockup's two inline result rows: confirmed
 * when gross minus every deduction equals net, a warning with the difference
 * when it does not, and "$?" while an amount is missing or not an amount.
 */
export function GateNotice({ gate }: { gate: Gate }) {
  switch (gate.status) {
    case 'ok':
      return (
        <Notice tone="confirmed" compact title="The math checks out.">
          Gross minus every deduction equals net pay, to the cent.
        </Notice>
      );
    case 'off':
      return (
        <Notice tone="warning" compact title="These don't add up.">
          Gross minus deductions is off from net pay by{' '}
          <Money cents={Math.abs(gate.differenceCents)} />. Check the edited field.
        </Notice>
      );
    case 'unknown':
      return (
        <Notice tone="warning" compact title="Can't check the math yet.">
          {gate.label} is {gate.reason === 'invalid' ? 'not an amount yet' : 'missing'}, so the
          difference is $?.
        </Notice>
      );
    case 'none':
      return null;
  }
}

/**
 * The server's own diff after it refused the values (422
 * `pay_stub_unbalanced`). Every number is the API's, formatted only.
 */
export function ServerDiff({ balance }: { balance: PayStubBalance }) {
  const rows: [string, number][] = [
    ['Gross pay', balance.gross_cents],
    ['Deductions', balance.deductions_cents],
    ['Gross minus deductions', balance.expected_net_cents],
    ['Net pay', balance.net_cents],
    ['Off by', Math.abs(balance.difference_cents)],
  ];
  return (
    <Notice tone="warning" compact role="alert" title="The server found that these don't add up.">
      Nothing was saved. Fix the amount that is off, then continue.
      <ul className="m-0 mt-2 flex list-none flex-col gap-0.5 p-0">
        {rows.map(([label, cents]) => (
          <li key={label} className="flex justify-between gap-3">
            <span>{label}</span>
            <Money cents={cents} />
          </li>
        ))}
      </ul>
    </Notice>
  );
}
