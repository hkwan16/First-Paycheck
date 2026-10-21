"""A scripted ``SyncProvider`` for pipeline and job tests: no network."""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable, Mapping, Sequence
from decimal import Decimal

from db.enums import AccountKind
from sync.provider import (
    ProviderAccount,
    ProviderBalance,
    ProviderHolding,
    ProviderTransaction,
    RemovedTransaction,
    TransactionPage,
)

Outcome = TransactionPage | Exception


class FakeProvider:
    """Answers ``fetch_transactions(cursor)`` from ``pages``.

    A cursor maps to a page, an exception to raise, or a sequence of those
    consumed one call at a time (to script "fails once, then succeeds").
    ``before_fetch`` runs before every transactions call, for tests that
    change the database while a sync is in flight.
    """

    def __init__(
        self,
        *,
        accounts: Sequence[ProviderAccount] = (),
        pages: Mapping[str | None, Outcome | Sequence[Outcome]] | None = None,
        balances: Sequence[ProviderBalance] = (),
        holdings: Sequence[ProviderHolding] = (),
        before_fetch: Callable[[str | None], None] | None = None,
        accounts_error: Exception | None = None,
    ) -> None:
        self._accounts = list(accounts)
        self._pages = {cursor: _queue(outcome) for cursor, outcome in (pages or {}).items()}
        self._balances = list(balances)
        self._holdings = list(holdings)
        self._before_fetch = before_fetch
        self._accounts_error = accounts_error
        self.cursors: list[str | None] = []

    def fetch_accounts(self) -> list[ProviderAccount]:
        if self._accounts_error is not None:
            raise self._accounts_error
        return list(self._accounts)

    def fetch_transactions(self, cursor: str | None) -> TransactionPage:
        self.cursors.append(cursor)
        if self._before_fetch is not None:
            self._before_fetch(cursor)
        outcomes = self._pages.get(cursor)
        if not outcomes:
            raise AssertionError(f"FakeProvider has no page for cursor {cursor!r}")
        outcome = outcomes.pop(0) if len(outcomes) > 1 else outcomes[0]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    def fetch_balances(self) -> list[ProviderBalance]:
        return list(self._balances)

    def fetch_holdings(self) -> list[ProviderHolding]:
        return list(self._holdings)


def _queue(outcome: Outcome | Sequence[Outcome]) -> list[Outcome]:
    if isinstance(outcome, TransactionPage | Exception):
        return [outcome]
    return list(outcome)


# ---------------------------------------------------------------- builders

CHECKING = ProviderAccount(
    provider_account_id="acc-checking",
    name="Plaid Checking",
    kind=AccountKind.CHECKING,
    mask="0000",
)
SAVINGS = ProviderAccount(
    provider_account_id="acc-savings", name="Plaid Saving", kind=AccountKind.SAVINGS, mask="1111"
)
BROKERAGE = ProviderAccount(
    provider_account_id="acc-brokerage",
    name="Plaid Brokerage",
    kind=AccountKind.INVESTMENT,
    mask="2222",
)


def txn(
    provider_txn_id: str,
    amount_cents: int,
    merchant_raw: str = "NETFLIX.COM #1234",
    *,
    account: str = "acc-checking",
    posted_at: dt.date = dt.date(2026, 10, 1),
    merchant_clean: str | None = None,
    pending: bool = False,
) -> ProviderTransaction:
    return ProviderTransaction(
        provider_txn_id=provider_txn_id,
        provider_account_id=account,
        posted_at=posted_at,
        amount_cents=amount_cents,
        merchant_raw=merchant_raw,
        merchant_clean=merchant_clean,
        pending=pending,
    )


def page(
    next_cursor: str,
    *,
    added: Sequence[ProviderTransaction] = (),
    modified: Sequence[ProviderTransaction] = (),
    removed: Sequence[str] = (),
    has_more: bool = False,
) -> TransactionPage:
    return TransactionPage(
        added=list(added),
        modified=list(modified),
        removed=[
            RemovedTransaction(provider_txn_id=r, provider_account_id="acc-checking")
            for r in removed
        ],
        next_cursor=next_cursor,
        has_more=has_more,
    )


def balance(account: str, cents: int) -> ProviderBalance:
    return ProviderBalance(provider_account_id=account, balance_cents=cents)


def holding(security_id: str, value_cents: int, *, as_of: dt.date | None = None) -> ProviderHolding:
    return ProviderHolding(
        provider_account_id="acc-brokerage",
        security_id=security_id,
        name=f"Security {security_id}",
        ticker=security_id.upper(),
        quantity=Decimal("2.5"),
        value_cents=value_cents,
        cost_basis_cents=None,
        as_of=as_of,
    )
