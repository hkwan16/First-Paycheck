"""PlaidProvider: Plaid JSON to SyncProvider DTOs (spec 002 rules 2-9)."""

from __future__ import annotations

import datetime as dt
import logging
import re
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Protocol

from pydantic import SecretStr

from db.enums import AccountKind
from jobs.errors import RetryLater
from sync.plaid.client import PlaidError
from sync.provider import (
    ItemLoginRequired,
    PaginationMutated,
    ProviderAccount,
    ProviderBalance,
    ProviderHolding,
    ProviderTransaction,
    RemovedTransaction,
    TransactionPage,
)

log = logging.getLogger(__name__)

__all__ = ["PlaidApiClient", "PlaidProvider", "account_kind", "to_cents"]

SAVINGS_SUBTYPES = frozenset({"savings", "money market", "cd", "hsa"})
RETIREMENT_SUBTYPES = frozenset(
    {
        "401a",
        "401k",
        "403b",
        "457b",
        "ira",
        "roth",
        "roth 401k",
        "sep ira",
        "simple ira",
        "keogh",
        "pension",
        "retirement",
        "thrift savings plan",
        "tsp",
        "lif",
        "lira",
        "rrsp",
        "rrif",
        "tfsa",
    }
)
NO_INVESTMENTS = frozenset(
    {
        "PRODUCTS_NOT_SUPPORTED",
        "NO_INVESTMENT_ACCOUNTS",
        "PRODUCT_NOT_ENABLED",
        "INVALID_PRODUCT",
        "ADDITIONAL_CONSENT_REQUIRED",
    }
)
# How long to wait before retrying a sync whose data Plaid is still preparing.
NOT_READY_RETRY_SECONDS = 120
_MASK = re.compile(r"\d{2,4}")


class PlaidApiClient(Protocol):
    """The part of PlaidClient the provider uses."""

    def accounts_get(self, access_token: SecretStr) -> dict[str, Any]: ...

    def transactions_sync(self, access_token: SecretStr, cursor: str | None) -> dict[str, Any]: ...

    def investments_holdings_get(self, access_token: SecretStr) -> dict[str, Any]: ...


def to_cents(dollars: Decimal | int) -> int:
    """Dollars to integer cents, rounding a half cent away from zero (rule 2)."""
    if isinstance(dollars, bool) or not isinstance(dollars, Decimal | int):
        raise TypeError(f"Plaid amounts must be Decimal or int, not {type(dollars).__name__}")
    return int((Decimal(dollars) * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def account_kind(plaid_type: str, subtype: str | None) -> AccountKind | None:
    """Map Plaid's type and subtype to an account kind; None means skip (rule 4)."""
    sub = (subtype or "").lower()
    match plaid_type:
        case "depository":
            return AccountKind.SAVINGS if sub in SAVINGS_SUBTYPES else AccountKind.CHECKING
        case "credit":
            return AccountKind.CREDIT
        case "loan":
            return AccountKind.LOAN
        case "investment":
            return AccountKind.RETIREMENT if sub in RETIREMENT_SUBTYPES else AccountKind.INVESTMENT
        case _:
            return None


def _translate(error: PlaidError) -> Exception:
    match error.code:
        case "PRODUCT_NOT_READY":
            return RetryLater(
                "Plaid has not finished preparing this item's data",
                after_seconds=NOT_READY_RETRY_SECONDS,
            )
        case "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION":
            return PaginationMutated(str(error))
        case "ITEM_LOGIN_REQUIRED":
            return ItemLoginRequired(str(error))
        case _:
            return error


class PlaidProvider:
    """One Plaid item, as a SyncProvider. Build a new one per sync."""

    def __init__(self, client: PlaidApiClient, access_token: SecretStr) -> None:
        self._client = client
        self._token = access_token
        self._accounts: list[dict[str, Any]] | None = None

    def __repr__(self) -> str:
        return "PlaidProvider(access_token=**********)"

    def fetch_accounts(self) -> list[ProviderAccount]:
        accounts = []
        for raw in self._raw_accounts():
            kind = account_kind(raw["type"], raw.get("subtype"))
            if kind is None:
                log.info("skipping a Plaid account of type %r", raw["type"])
                continue
            mask = raw.get("mask")
            accounts.append(
                ProviderAccount(
                    provider_account_id=raw["account_id"],
                    name=raw.get("name") or raw.get("official_name") or "Account",
                    kind=kind,
                    mask=mask if isinstance(mask, str) and _MASK.fullmatch(mask) else None,
                )
            )
        return accounts

    def fetch_balances(self) -> list[ProviderBalance]:
        balances = []
        for raw in self._raw_accounts():
            if account_kind(raw["type"], raw.get("subtype")) is None:
                continue
            amounts = raw.get("balances") or {}
            amount = amounts.get("current")
            if amount is None:
                amount = amounts.get("available")
            if amount is None:
                continue
            balance = ProviderBalance(
                provider_account_id=raw["account_id"], balance_cents=to_cents(amount)
            )
            balances.append(balance)
        return balances

    def fetch_transactions(self, cursor: str | None) -> TransactionPage:
        try:
            body = self._client.transactions_sync(self._token, cursor)
        except PlaidError as error:
            raise _translate(error) from None
        if cursor is None and body.get("transactions_update_status") == "NOT_READY":
            raise RetryLater(
                "Plaid has not pulled this item's transactions yet",
                after_seconds=NOT_READY_RETRY_SECONDS,
            )
        return TransactionPage(
            added=[_transaction(raw) for raw in body["added"]],
            modified=[_transaction(raw) for raw in body["modified"]],
            removed=[
                RemovedTransaction(
                    provider_txn_id=raw["transaction_id"],
                    provider_account_id=raw.get("account_id"),
                )
                for raw in body["removed"]
            ],
            next_cursor=body["next_cursor"],
            has_more=body["has_more"],
        )

    def fetch_holdings(self) -> list[ProviderHolding]:
        try:
            body = self._client.investments_holdings_get(self._token)
        except PlaidError as error:
            if error.code in NO_INVESTMENTS:
                return []
            raise _translate(error) from None
        securities = {raw["security_id"]: raw for raw in body["securities"]}
        holdings = []
        for raw in body["holdings"]:
            security = securities.get(raw["security_id"], {})
            cost_basis = raw.get("cost_basis")
            as_of = raw.get("institution_price_as_of")
            holdings.append(
                ProviderHolding(
                    provider_account_id=raw["account_id"],
                    security_id=raw["security_id"],
                    name=security.get("name") or security.get("ticker_symbol") or "Security",
                    ticker=security.get("ticker_symbol"),
                    quantity=Decimal(raw["quantity"]),
                    value_cents=to_cents(raw["institution_value"]),
                    cost_basis_cents=None if cost_basis is None else to_cents(cost_basis),
                    as_of=None if as_of is None else dt.date.fromisoformat(as_of),
                )
            )
        return holdings

    def _raw_accounts(self) -> list[dict[str, Any]]:
        if self._accounts is None:
            try:
                self._accounts = list(self._client.accounts_get(self._token)["accounts"])
            except PlaidError as error:
                raise _translate(error) from None
        return self._accounts


def _transaction(raw: dict[str, Any]) -> ProviderTransaction:
    return ProviderTransaction(
        provider_txn_id=raw["transaction_id"],
        provider_account_id=raw["account_id"],
        posted_at=dt.date.fromisoformat(raw["date"]),
        amount_cents=to_cents(raw["amount"]),
        merchant_raw=raw["name"],
        merchant_clean=raw.get("merchant_name"),
        pending=bool(raw["pending"]),
    )
