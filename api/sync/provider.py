"""The sync provider interface (spec 002 rules 1-9).

Plaid and the later CSV importer implement ``SyncProvider``; ``pipeline.run_sync``
is the only caller. Every DTO carries money as integer cents with Plaid's sign
convention (``amount_cents > 0`` is money out).
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal
from typing import Annotated, Protocol

from pydantic import BaseModel, ConfigDict, Field

from db.enums import AccountKind
from jobs.errors import RetryLater

Cents = Annotated[int, Field(strict=True)]

# How long to wait before retrying a sync whose data the provider is still preparing.
NOT_READY_RETRY_SECONDS = 120

__all__ = [
    "NOT_READY_RETRY_SECONDS",
    "Cents",
    "ItemLoginRequired",
    "PaginationMutated",
    "ProviderAccount",
    "ProviderBalance",
    "ProviderError",
    "ProviderHolding",
    "ProviderTransaction",
    "RemovedTransaction",
    "RetryLater",
    "SyncProvider",
    "TransactionPage",
    "TransactionsNotReady",
]


class _Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class ProviderAccount(_Frozen):
    provider_account_id: str
    name: str
    kind: AccountKind
    mask: str | None


class ProviderTransaction(_Frozen):
    provider_txn_id: str
    provider_account_id: str
    posted_at: dt.date
    amount_cents: Cents
    merchant_raw: str
    merchant_clean: str | None
    pending: bool


class RemovedTransaction(_Frozen):
    provider_txn_id: str
    provider_account_id: str | None


class TransactionPage(_Frozen):
    added: list[ProviderTransaction]
    modified: list[ProviderTransaction]
    removed: list[RemovedTransaction]
    next_cursor: str
    has_more: bool
    # The provider's own word for how far its pull has got (Plaid's
    # transactions_update_status); logged, never used to decide (rule 9a).
    update_status: str | None = None


class ProviderBalance(_Frozen):
    provider_account_id: str
    balance_cents: Cents


class ProviderHolding(_Frozen):
    provider_account_id: str
    security_id: str
    name: str
    ticker: str | None
    quantity: Decimal
    value_cents: Cents
    cost_basis_cents: Cents | None
    # None means "as of the sync date".
    as_of: dt.date | None


class ProviderError(Exception):
    """A provider call failed in a way the pipeline does not handle itself."""


class PaginationMutated(ProviderError):
    """The item changed mid-pagination; restart from the committed cursor."""


class ItemLoginRequired(ProviderError):
    """The institution needs the user to sign in again (Plaid update mode)."""


class TransactionsNotReady(ProviderError):
    """The provider has no transactions to give for this item yet (rule 9a).

    Said both while it is still pulling a new item's history and, for good,
    by an item that has no transactions; ``pipeline.run_sync`` tells the two
    apart by the item's age (rule 11a).
    """

    def __init__(self, update_status: str | None) -> None:
        super().__init__(f"transactions are not available yet (update status {update_status})")
        self.update_status = update_status


class SyncProvider(Protocol):
    def fetch_accounts(self) -> list[ProviderAccount]: ...

    def fetch_transactions(self, cursor: str | None) -> TransactionPage: ...

    def fetch_balances(self) -> list[ProviderBalance]: ...

    def fetch_holdings(self) -> list[ProviderHolding]: ...
