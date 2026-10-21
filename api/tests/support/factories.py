"""Row builders for tests. Each one writes as the owning user, under RLS, the
way the API and the worker do, so a builder can never create a row its user
could not create."""

from __future__ import annotations

import datetime as dt
import uuid
from decimal import Decimal
from typing import Any

from sqlalchemy import Connection

from app.db import user_session_for
from db.enums import AccountKind, CategorySource, JobKind, SyncProvider
from db.models import (
    Account,
    BalanceSnapshot,
    Holding,
    Job,
    SyncItem,
    Transaction,
)
from sync.categorize import normalize_merchant


def make_item(
    connection: Connection,
    user_id: uuid.UUID,
    *,
    provider_item_id: str | None = None,
    institution_name: str = "First Platypus Bank",
    access_token_enc: bytes = b"not-a-real-ciphertext",
    cursor: str | None = None,
) -> uuid.UUID:
    with user_session_for(user_id, bind=connection) as session:
        item = SyncItem(
            user_id=user_id,
            provider=SyncProvider.PLAID,
            provider_item_id=provider_item_id or f"item-{uuid.uuid4().hex[:12]}",
            institution_name=institution_name,
            access_token_enc=access_token_enc,
            cursor=cursor,
        )
        session.add(item)
        session.flush()
        return item.id


def make_account(
    connection: Connection,
    user_id: uuid.UUID,
    item_id: uuid.UUID,
    *,
    kind: AccountKind = AccountKind.CHECKING,
    name: str = "Plaid Checking",
    provider_account_id: str | None = None,
    mask: str | None = "0000",
    **fields: Any,
) -> uuid.UUID:
    with user_session_for(user_id, bind=connection) as session:
        account = Account(
            user_id=user_id,
            sync_item_id=item_id,
            provider_account_id=provider_account_id or f"acct-{uuid.uuid4().hex[:12]}",
            kind=kind,
            name=name,
            mask=mask,
            **fields,
        )
        session.add(account)
        session.flush()
        return account.id


def make_transaction(
    connection: Connection,
    user_id: uuid.UUID,
    account_id: uuid.UUID,
    *,
    merchant_raw: str = "NETFLIX.COM #1234",
    amount_cents: int = 1599,
    posted_at: dt.date = dt.date(2026, 10, 1),
    category: str | None = None,
    category_source: CategorySource | None = None,
    confidence: Decimal | None = None,
    provider_txn_id: str | None = None,
) -> uuid.UUID:
    with user_session_for(user_id, bind=connection) as session:
        txn = Transaction(
            user_id=user_id,
            account_id=account_id,
            provider_txn_id=provider_txn_id or f"txn-{uuid.uuid4().hex[:12]}",
            posted_at=posted_at,
            amount_cents=amount_cents,
            merchant_raw=merchant_raw,
            merchant_norm=normalize_merchant(merchant_raw),
            category=category,
            category_source=category_source,
            confidence=confidence,
        )
        session.add(txn)
        session.flush()
        return txn.id


def make_snapshot(
    connection: Connection,
    user_id: uuid.UUID,
    account_id: uuid.UUID,
    *,
    balance_cents: int = 100_000,
    as_of: dt.datetime | None = None,
) -> uuid.UUID:
    with user_session_for(user_id, bind=connection) as session:
        snapshot = BalanceSnapshot(
            user_id=user_id,
            account_id=account_id,
            as_of=as_of or dt.datetime(2026, 10, 1, 12, tzinfo=dt.UTC),
            balance_cents=balance_cents,
        )
        session.add(snapshot)
        session.flush()
        return snapshot.id


def make_holding(connection: Connection, user_id: uuid.UUID, account_id: uuid.UUID) -> uuid.UUID:
    with user_session_for(user_id, bind=connection) as session:
        holding = Holding(
            user_id=user_id,
            account_id=account_id,
            as_of=dt.date(2026, 10, 1),
            security_id="sec-vti",
            name="Vanguard Total Stock Market ETF",
            ticker="VTI",
            quantity=Decimal("3.5"),
            value_cents=98_000,
            cost_basis_cents=90_000,
        )
        session.add(holding)
        session.flush()
        return holding.id


def make_job(
    connection: Connection,
    user_id: uuid.UUID,
    *,
    kind: JobKind = JobKind.CATEGORIZE_RUN,
    payload: dict[str, Any] | None = None,
) -> uuid.UUID:
    with user_session_for(user_id, bind=connection) as session:
        job = Job(user_id=user_id, kind=kind, payload=payload or {})
        session.add(job)
        session.flush()
        return job.id
