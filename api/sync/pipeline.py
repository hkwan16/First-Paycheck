"""``run_sync``: one provider sync, written idempotently (spec 002 rules 10-18).

Read, fetch, write: a short user session reads the item, the provider is
called with no transaction open, and one more user session writes accounts,
transactions, balance snapshots, holdings and the new cursor together. The
cursor is saved only with the data of its last page, so a crash replays the
same pages and the upserts make the replay harmless.
"""

from __future__ import annotations

import datetime as dt
import logging
import uuid
from collections.abc import Callable, Iterable, Sequence
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from typing import Any, Literal

from sqlalchemy import and_, case, delete, or_, select, tuple_, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from db.enums import CategorySource, JobKind, SyncStatus
from db.enums import SyncProvider as SyncProviderKind
from db.models import Account, BalanceSnapshot, Holding, SyncItem, Transaction
from jobs import queue
from jobs.errors import RetryLater
from sync.categorize import normalize_merchant
from sync.provider import (
    ItemLoginRequired,
    PaginationMutated,
    ProviderAccount,
    ProviderBalance,
    ProviderHolding,
    ProviderTransaction,
    SyncProvider,
    TransactionPage,
)

logger = logging.getLogger(__name__)

MAX_PAGINATION_RESTARTS = 3
WRITE_BATCH = 500

Outcome = Literal["synced", "stale", "item_missing", "login_required"]
SessionFactory = Callable[[], AbstractContextManager[Session]]


@dataclass(frozen=True)
class SyncItemSecrets:
    """What a provider factory needs to build a provider for one item."""

    id: uuid.UUID
    provider: SyncProviderKind
    provider_item_id: str | None
    access_token_enc: bytes | None = field(repr=False)


ProviderFactory = Callable[[SyncItemSecrets], SyncProvider]


@dataclass(frozen=True)
class SyncResult:
    outcome: Outcome
    accounts: int = 0
    added: int = 0
    modified: int = 0
    removed: int = 0
    skipped: int = 0
    balances: int = 0
    holdings: int = 0

    def as_job_result(self) -> dict[str, Any]:
        return {
            "outcome": self.outcome,
            "accounts": self.accounts,
            "added": self.added,
            "modified": self.modified,
            "removed": self.removed,
            "skipped": self.skipped,
            "balances": self.balances,
            "holdings": self.holdings,
        }


@dataclass(frozen=True)
class _Fetched:
    accounts: list[ProviderAccount]
    balances: list[ProviderBalance]
    holdings: list[ProviderHolding]
    pages: list[TransactionPage]


def run_sync(
    *,
    user_id: uuid.UUID,
    item_id: uuid.UUID,
    sessions: SessionFactory,
    provider_for: ProviderFactory,
    now: dt.datetime | None = None,
) -> SyncResult:
    now = now or dt.datetime.now(dt.UTC)
    with sessions() as session:
        item = session.get(SyncItem, item_id)
        if item is None:
            return SyncResult(outcome="item_missing")
        start_cursor = item.cursor
        secrets = SyncItemSecrets(
            id=item.id,
            provider=item.provider,
            provider_item_id=item.provider_item_id,
            access_token_enc=item.access_token_enc,
        )

    provider = provider_for(secrets)
    try:
        fetched = _fetch(provider, start_cursor)
    except ItemLoginRequired:
        with sessions() as session:
            session.execute(
                update(SyncItem)
                .where(SyncItem.id == item_id)
                .values(status=SyncStatus.LOGIN_REQUIRED)
            )
        logger.info("sync item %s needs the user to sign in again", item_id)
        return SyncResult(outcome="login_required")

    with sessions() as session:
        locked = session.execute(
            select(SyncItem).where(SyncItem.id == item_id).with_for_update()
        ).scalar_one_or_none()
        if locked is None:
            return SyncResult(outcome="item_missing")
        if locked.cursor != start_cursor:
            logger.info("sync item %s was advanced by another sync; discarding", item_id)
            return SyncResult(outcome="stale")
        result = _write(session, user_id, item_id, fetched, now)
        locked.cursor = fetched.pages[-1].next_cursor
        locked.last_synced_at = now
        locked.status = SyncStatus.ACTIVE
        for kind in (JobKind.CATEGORIZE_RUN, JobKind.RECURRING_DETECT):
            queue.enqueue_unless_queued(session, user_id=user_id, kind=kind)
    return result


def _fetch(provider: SyncProvider, cursor: str | None) -> _Fetched:
    accounts = provider.fetch_accounts()
    balances = provider.fetch_balances()
    holdings = provider.fetch_holdings()
    for _ in range(MAX_PAGINATION_RESTARTS + 1):
        try:
            pages = _pages(provider, cursor)
        except PaginationMutated:
            logger.info("transactions changed during pagination; restarting from %r", cursor)
            continue
        return _Fetched(accounts=accounts, balances=balances, holdings=holdings, pages=pages)
    raise RetryLater("transactions kept changing during pagination", after_seconds=60)


def _pages(provider: SyncProvider, cursor: str | None) -> list[TransactionPage]:
    pages = [provider.fetch_transactions(cursor)]
    while pages[-1].has_more:
        pages.append(provider.fetch_transactions(pages[-1].next_cursor))
    return pages


def _write(
    session: Session,
    user_id: uuid.UUID,
    item_id: uuid.UUID,
    fetched: _Fetched,
    now: dt.datetime,
) -> SyncResult:
    account_ids = _upsert_accounts(session, user_id, item_id, fetched.accounts)
    added = modified = removed = skipped = 0
    for page in fetched.pages:
        added_rows, added_missing = _rows(user_id, account_ids, page.added)
        modified_rows, modified_missing = _rows(user_id, account_ids, page.modified)
        _upsert_transactions(session, [*added_rows, *modified_rows])
        removed += _delete_transactions(session, account_ids, page)
        added += len(added_rows)
        modified += len(modified_rows)
        skipped += added_missing + modified_missing
    return SyncResult(
        outcome="synced",
        accounts=len(account_ids),
        added=added,
        modified=modified,
        removed=removed,
        skipped=skipped,
        balances=_insert_snapshots(session, user_id, account_ids, fetched.balances, now),
        holdings=_upsert_holdings(session, user_id, account_ids, fetched.holdings, now.date()),
    )


def _upsert_accounts(
    session: Session, user_id: uuid.UUID, item_id: uuid.UUID, accounts: Sequence[ProviderAccount]
) -> dict[str, uuid.UUID]:
    if not accounts:
        existing = session.execute(
            select(Account.provider_account_id, Account.id).where(Account.sync_item_id == item_id)
        )
        return dict(existing.all())
    stmt = insert(Account).values(
        [
            {
                "user_id": user_id,
                "sync_item_id": item_id,
                "provider_account_id": account.provider_account_id,
                "name": account.name,
                "kind": account.kind,
                "mask": account.mask,
            }
            for account in accounts
        ]
    )
    upsert = stmt.on_conflict_do_update(
        index_elements=[Account.sync_item_id, Account.provider_account_id],
        set_={
            "name": stmt.excluded.name,
            "kind": stmt.excluded.kind,
            "mask": stmt.excluded.mask,
        },
    ).returning(Account.provider_account_id, Account.id)
    return dict(session.execute(upsert).all())


def _rows(
    user_id: uuid.UUID,
    account_ids: dict[str, uuid.UUID],
    transactions: Iterable[ProviderTransaction],
) -> tuple[list[dict[str, Any]], int]:
    rows: list[dict[str, Any]] = []
    missing = 0
    for txn in transactions:
        account_id = account_ids.get(txn.provider_account_id)
        if account_id is None:
            missing += 1
            continue
        rows.append(
            {
                "user_id": user_id,
                "account_id": account_id,
                "provider_txn_id": txn.provider_txn_id,
                "posted_at": txn.posted_at,
                "amount_cents": txn.amount_cents,
                "merchant_raw": txn.merchant_raw,
                "merchant_clean": txn.merchant_clean,
                "merchant_norm": normalize_merchant(txn.merchant_raw),
                "pending": txn.pending,
            }
        )
    return rows, missing


def _upsert_transactions(session: Session, rows: list[dict[str, Any]]) -> None:
    # One INSERT ... ON CONFLICT may not touch a row twice; the last version wins.
    rows = list({(row["account_id"], row["provider_txn_id"]): row for row in rows}.values())
    for start in range(0, len(rows), WRITE_BATCH):
        stmt = insert(Transaction).values(rows[start : start + WRITE_BATCH])
        # A label survives a modification when the merchant is unchanged or
        # the user set it; otherwise categorization runs again (rule 14).
        keep = or_(
            Transaction.category_source == CategorySource.USER,
            Transaction.merchant_norm == stmt.excluded.merchant_norm,
        )
        upsert = stmt.on_conflict_do_update(
            index_elements=[Transaction.account_id, Transaction.provider_txn_id],
            set_={
                "posted_at": stmt.excluded.posted_at,
                "amount_cents": stmt.excluded.amount_cents,
                "merchant_raw": stmt.excluded.merchant_raw,
                "merchant_clean": stmt.excluded.merchant_clean,
                "merchant_norm": stmt.excluded.merchant_norm,
                "pending": stmt.excluded.pending,
                "category": case((keep, Transaction.category), else_=None),
                "category_source": case((keep, Transaction.category_source), else_=None),
                "confidence": case((keep, Transaction.confidence), else_=None),
            },
        )
        session.execute(upsert)


def _delete_transactions(
    session: Session, account_ids: dict[str, uuid.UUID], page: TransactionPage
) -> int:
    ids = [removed.provider_txn_id for removed in page.removed]
    if not ids or not account_ids:
        return 0
    result = session.execute(
        delete(Transaction).where(
            and_(
                Transaction.account_id.in_(account_ids.values()),
                Transaction.provider_txn_id.in_(ids),
            )
        )
    )
    return int(result.rowcount)  # type: ignore[attr-defined]  # CursorResult for DML


def _insert_snapshots(
    session: Session,
    user_id: uuid.UUID,
    account_ids: dict[str, uuid.UUID],
    balances: Sequence[ProviderBalance],
    now: dt.datetime,
) -> int:
    rows = [
        {
            "user_id": user_id,
            "account_id": account_ids[balance.provider_account_id],
            "as_of": now,
            "balance_cents": balance.balance_cents,
        }
        for balance in balances
        if balance.provider_account_id in account_ids
    ]
    if not rows:
        return 0
    session.execute(
        insert(BalanceSnapshot)
        .values(rows)
        .on_conflict_do_nothing(index_elements=[BalanceSnapshot.account_id, BalanceSnapshot.as_of])
    )
    return len(rows)


def _upsert_holdings(
    session: Session,
    user_id: uuid.UUID,
    account_ids: dict[str, uuid.UUID],
    holdings: Sequence[ProviderHolding],
    today: dt.date,
) -> int:
    rows = [
        {
            "user_id": user_id,
            "account_id": account_ids[holding.provider_account_id],
            "as_of": holding.as_of or today,
            "security_id": holding.security_id,
            "name": holding.name,
            "ticker": holding.ticker,
            "quantity": holding.quantity,
            "value_cents": holding.value_cents,
            "cost_basis_cents": holding.cost_basis_cents,
        }
        for holding in holdings
        if holding.provider_account_id in account_ids
    ]
    if not rows:
        return 0
    stmt = insert(Holding).values(rows)
    session.execute(
        stmt.on_conflict_do_update(
            index_elements=[Holding.account_id, Holding.as_of, Holding.security_id],
            set_={
                "name": stmt.excluded.name,
                "ticker": stmt.excluded.ticker,
                "quantity": stmt.excluded.quantity,
                "value_cents": stmt.excluded.value_cents,
                "cost_basis_cents": stmt.excluded.cost_basis_cents,
            },
        )
    )
    # Positions the provider no longer reports for an (account, date) it did
    # report are gone.
    synced = {(row["account_id"], row["as_of"]) for row in rows}
    kept = {(row["account_id"], row["as_of"], row["security_id"]) for row in rows}
    session.execute(
        delete(Holding).where(
            tuple_(Holding.account_id, Holding.as_of).in_(synced),
            tuple_(Holding.account_id, Holding.as_of, Holding.security_id).not_in(kept),
        )
    )
    return len(rows)
