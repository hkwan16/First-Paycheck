"""run_sync against a FakeProvider (spec 002 rules 10-18, examples 3-6)."""

from __future__ import annotations

import datetime as dt
from contextlib import AbstractContextManager
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import Connection, text
from sqlalchemy.orm import Session

from app.db import user_session_for
from db.enums import CategorySource
from jobs.errors import RetryLater
from sync.pipeline import SyncItemSecrets, run_sync
from sync.provider import ItemLoginRequired, PaginationMutated, SyncProvider
from tests.conftest import FixtureUser
from tests.support.factories import make_item
from tests.support.fake_provider import (
    BROKERAGE,
    CHECKING,
    SAVINGS,
    FakeProvider,
    Outcome,
    balance,
    holding,
    page,
    txn,
)

NOW = dt.datetime(2026, 10, 21, 15, 0, tzinfo=dt.UTC)


PAGE_TWO = page(
    "c2",
    modified=[txn("t1", 1325)],
    removed=["t2"],
    added=[txn("t3", -100_000, "ADP PAYROLL 1023", account="acc-savings")],
)


def two_pages(second: Outcome | list[Outcome] = PAGE_TWO) -> FakeProvider:
    return FakeProvider(
        accounts=[CHECKING, SAVINGS],
        balances=[balance("acc-checking", 250_000), balance("acc-savings", 1_000_000)],
        pages={
            None: page(
                "c1",
                added=[txn("t1", 1200), txn("t2", 550, "STARBUCKS STORE 123")],
                has_more=True,
            ),
            "c1": second,
        },
    )


class Harness:
    def __init__(self, connection: Connection, user: FixtureUser) -> None:
        self.connection = connection
        self.user = user
        self.item_id = make_item(connection, user.id)

    def sessions(self) -> AbstractContextManager[Session]:
        return user_session_for(self.user.id, bind=self.connection)

    def run(self, provider: SyncProvider, *, now: dt.datetime = NOW) -> Any:
        seen: list[SyncItemSecrets] = []

        def provider_for(secrets: SyncItemSecrets) -> SyncProvider:
            seen.append(secrets)
            return provider

        result = run_sync(
            user_id=self.user.id,
            item_id=self.item_id,
            sessions=self.sessions,
            provider_for=provider_for,
            now=now,
        )
        assert all(secrets.id == self.item_id for secrets in seen)
        return result

    def query(self, sql: str, **params: object) -> list[Any]:
        with self.sessions() as session:
            return list(session.execute(text(sql), params).all())

    def transactions(self) -> dict[str, tuple[int, str]]:
        rows = self.query("SELECT provider_txn_id, amount_cents, merchant_norm FROM transactions")
        return {row[0]: (row[1], row[2]) for row in rows}

    def item(self) -> Any:
        return self.query(
            "SELECT cursor, status, last_synced_at FROM sync_items WHERE id = :id", id=self.item_id
        )[0]

    def queued(self) -> list[str]:
        rows = self.query("SELECT kind FROM jobs WHERE status = 'queued' ORDER BY kind")
        return [row[0] for row in rows]


@pytest.fixture
def harness(db_connection: Connection, user_a: FixtureUser) -> Harness:
    db_connection.execute(text("DELETE FROM jobs"))
    return Harness(db_connection, user_a)


def test_two_pages_added_modified_removed(harness: Harness) -> None:
    result = harness.run(two_pages())

    assert harness.transactions() == {
        "t1": (1325, "netflix.com"),
        "t3": (-100_000, "adp payroll"),
    }
    assert tuple(harness.item()) == ("c2", "active", NOW)
    assert result.outcome == "synced"
    assert (result.accounts, result.added, result.modified, result.removed) == (2, 3, 1, 1)
    balances = harness.query(
        "SELECT a.provider_account_id, b.balance_cents, b.as_of FROM balance_snapshots b"
        " JOIN accounts a ON a.id = b.account_id ORDER BY 1"
    )
    assert [tuple(row) for row in balances] == [
        ("acc-checking", 250_000, NOW),
        ("acc-savings", 1_000_000, NOW),
    ]
    assert harness.queued() == ["categorize.run", "recurring.detect"]


def test_cursor_saved_only_after_last_page(harness: Harness) -> None:
    provider = FakeProvider(
        accounts=[CHECKING],
        pages={None: page("c1", added=[txn("t1", 100)], has_more=True), "c1": RuntimeError("500")},
    )
    with pytest.raises(RuntimeError, match="500"):
        harness.run(provider)
    assert harness.item()[0] is None
    assert harness.transactions() == {}
    assert harness.query("SELECT count(*) FROM accounts")[0][0] == 0
    assert harness.queued() == []


def test_rerun_is_idempotent(harness: Harness) -> None:
    harness.run(two_pages())
    first = harness.transactions()
    # A crash after the fetch but before the commit replays from the old cursor.
    harness.connection.execute(
        text("UPDATE sync_items SET cursor = NULL WHERE id = :id"), {"id": harness.item_id}
    )
    harness.run(two_pages(), now=NOW + dt.timedelta(hours=1))

    assert harness.transactions() == first
    assert harness.query("SELECT count(*) FROM accounts")[0][0] == 2
    assert harness.query("SELECT count(*) FROM balance_snapshots")[0][0] == 4
    assert harness.queued() == ["categorize.run", "recurring.detect"]


def test_mutation_restarts_from_committed_cursor(harness: Harness) -> None:
    provider = two_pages([PaginationMutated("changed"), PAGE_TWO])
    harness.run(provider)
    assert provider.cursors == [None, "c1", None, "c1"]
    assert harness.transactions() == {
        "t1": (1325, "netflix.com"),
        "t3": (-100_000, "adp payroll"),
    }


def test_repeated_mutation_retries_later(harness: Harness) -> None:
    provider = FakeProvider(accounts=[CHECKING], pages={None: PaginationMutated("again")})
    with pytest.raises(RetryLater):
        harness.run(provider)
    assert provider.cursors == [None] * 4
    assert harness.item()[0] is None


def test_concurrent_sync_makes_this_one_stale(harness: Harness) -> None:
    def advance(cursor: str | None) -> None:
        if cursor is None:
            with harness.sessions() as session:
                session.execute(
                    text("UPDATE sync_items SET cursor = 'other' WHERE id = :id"),
                    {"id": harness.item_id},
                )

    provider = FakeProvider(
        accounts=[CHECKING], pages={None: page("c1", added=[txn("t1", 100)])}, before_fetch=advance
    )
    result = harness.run(provider)
    assert result.outcome == "stale"
    assert harness.item()[0] == "other"
    assert harness.transactions() == {}


def label(harness: Harness, provider_txn_id: str, source: CategorySource) -> None:
    confidence = Decimal("0.700") if source is CategorySource.LLM else None
    harness.connection.execute(
        text(
            "UPDATE transactions SET category = 'entertainment',"
            " category_source = CAST(:source AS category_source), confidence = :c"
            " WHERE provider_txn_id = :id"
        ),
        {"source": source.value, "c": confidence, "id": provider_txn_id},
    )


def categories(harness: Harness) -> dict[str, tuple[str | None, str | None]]:
    rows = harness.query("SELECT provider_txn_id, category, category_source FROM transactions")
    return {row[0]: (row[1], row[2]) for row in rows}


def test_modified_transactions_keep_or_clear_their_category(harness: Harness) -> None:
    harness.run(
        FakeProvider(
            accounts=[CHECKING],
            pages={
                None: page(
                    "c1",
                    added=[
                        txn("same", 100, "NETFLIX.COM"),
                        txn("renamed", 100, "NETFLIX.COM"),
                        txn("user", 100, "NETFLIX.COM"),
                    ],
                )
            },
        )
    )
    label(harness, "same", CategorySource.LLM)
    label(harness, "renamed", CategorySource.RULE)
    label(harness, "user", CategorySource.USER)

    harness.run(
        FakeProvider(
            accounts=[CHECKING],
            pages={
                "c1": page(
                    "c2",
                    modified=[
                        txn("same", 250, "NETFLIX.COM #77"),
                        txn("renamed", 100, "HULU"),
                        txn("user", 100, "HULU"),
                    ],
                )
            },
        )
    )
    assert categories(harness) == {
        "same": ("entertainment", "llm"),
        "renamed": (None, None),
        "user": ("entertainment", "user"),
    }


def test_transactions_for_unknown_accounts_are_skipped(harness: Harness) -> None:
    result = harness.run(
        FakeProvider(
            accounts=[CHECKING],
            pages={None: page("c1", added=[txn("t1", 100), txn("t2", 100, account="acc-loan")])},
        )
    )
    assert set(harness.transactions()) == {"t1"}
    assert result.skipped == 1


def test_account_upsert_keeps_user_fields(harness: Harness) -> None:
    harness.run(FakeProvider(accounts=[CHECKING], pages={None: page("c1")}))
    harness.connection.execute(
        text("UPDATE accounts SET role = 'spending', is_active = false, name = 'old'")
    )
    harness.run(FakeProvider(accounts=[CHECKING], pages={"c1": page("c2")}))
    row = harness.query("SELECT name, role, is_active FROM accounts")[0]
    assert tuple(row) == ("Plaid Checking", "spending", False)


def test_holdings_are_upserted_and_pruned(harness: Harness) -> None:
    day = dt.date(2026, 10, 20)
    harness.run(
        FakeProvider(
            accounts=[BROKERAGE],
            pages={None: page("c1")},
            holdings=[holding("vti", 100_000, as_of=day), holding("bnd", 50_000, as_of=day)],
        )
    )
    result = harness.run(
        FakeProvider(
            accounts=[BROKERAGE],
            pages={"c1": page("c2")},
            holdings=[holding("vti", 110_000, as_of=day), holding("vxus", 20_000)],
        )
    )
    rows = harness.query("SELECT security_id, value_cents, as_of FROM holdings ORDER BY 1")
    assert [tuple(row) for row in rows] == [
        ("vti", 110_000, day),
        ("vxus", 20_000, NOW.date()),
    ]
    assert result.holdings == 2


def test_missing_item_is_a_no_op(harness: Harness) -> None:
    with harness.sessions() as session:
        session.execute(text("DELETE FROM sync_items WHERE id = :id"), {"id": harness.item_id})
    result = harness.run(FakeProvider())
    assert result.outcome == "item_missing"


def test_login_required_marks_the_item(harness: Harness) -> None:
    result = harness.run(FakeProvider(accounts_error=ItemLoginRequired("ITEM_LOGIN_REQUIRED")))
    assert result.outcome == "login_required"
    assert harness.item()[1] == "login_required"


def test_follow_up_jobs_are_not_duplicated(harness: Harness) -> None:
    harness.run(FakeProvider(accounts=[CHECKING], pages={None: page("c1")}))
    harness.run(FakeProvider(accounts=[CHECKING], pages={"c1": page("c2")}))
    assert harness.queued() == ["categorize.run", "recurring.detect"]


def test_sync_never_sees_another_users_item(
    db_connection: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    item = make_item(db_connection, user_a.id)

    def factory(_: SyncItemSecrets) -> SyncProvider:
        raise AssertionError("B must never reach A's provider")

    result = run_sync(
        user_id=user_b.id,
        item_id=item,
        sessions=lambda: user_session_for(user_b.id, bind=db_connection),
        provider_for=factory,
        now=NOW,
    )
    assert result.outcome == "item_missing"


def test_a_transaction_added_and_modified_in_one_page_keeps_the_modification(
    harness: Harness,
) -> None:
    harness.run(
        FakeProvider(
            accounts=[CHECKING],
            pages={None: page("c1", added=[txn("t1", 100)], modified=[txn("t1", 175)])},
        )
    )
    assert harness.transactions() == {"t1": (175, "netflix.com")}
