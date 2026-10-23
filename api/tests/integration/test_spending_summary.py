"""GET /spending/summary on a hand-built month (spec 007 part B)."""

from __future__ import annotations

import datetime as dt
import uuid
from collections import Counter
from collections.abc import Callable
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Connection

from app.db import user_session_for
from app.deps import get_now
from db.enums import AccountKind
from db.models import Account
from sync.categories import CATEGORIES, CATEGORY_BUCKETS
from tests.conftest import FixtureUser
from tests.support.factories import (
    make_account,
    make_item,
)
from tests.support.sandbox_history import DYNAMIC, link_sandbox
from tests.support.spending_month import loan_ledger_month, september, spend

Client = Callable[[FixtureUser], TestClient]
NOW = dt.datetime(2026, 10, 21, 15, 0, tzinfo=dt.UTC)
SEPTEMBER = {"start": "2026-09-01", "end": "2026-09-30"}
OCTOBER = {"start": "2026-10-01", "end": "2026-10-31"}


@pytest.fixture
def frozen(app: FastAPI) -> FastAPI:
    app.dependency_overrides[get_now] = lambda: NOW
    return app


@pytest.fixture
def account(db_connection: Connection, user_a: FixtureUser) -> uuid.UUID:
    return make_account(db_connection, user_a.id, make_item(db_connection, user_a.id))


def test_the_spec_month(
    frozen: FastAPI,
    client_as: Client,
    user_a: FixtureUser,
    account: uuid.UUID,
    db_connection: Connection,
) -> None:
    september(db_connection, user_a, account)
    response = client_as(user_a).get("/spending/summary", params=SEPTEMBER)
    assert response.status_code == 200, response.text
    body = response.json()
    assert {key: value for key, value in body.items() if key != "category_buckets"} == {
        "start": "2026-09-01",
        "end": "2026-09-30",
        "income_cents": 399_208,
        "essentials_cents": 180_000,
        "flexible_cents": 8_500,
        "savings_cents": 40_000,
        "other_cents": 3_900,
        "transfers_ignored_cents": 25_000,
        "income_outflows_ignored_cents": 0,
        "uncategorized_cents": 1_200,
        "left_over_cents": 166_808,
        "essentials_pct": "45.1",
        "flexible_pct": "2.1",
        "savings_rate_pct": "10.0",
        "transaction_count": 10,
        "uncategorized_count": 1,
        "paycheck_count": 2,
        "ledger_rows_skipped": {"count": 0, "net_cents": 0},
        "account_kinds_counted": ["checking", "savings", "credit"],
        "categories": [
            {"category": "income", "bucket": "income", "total_cents": 399_208, "count": 2},
            {"category": "transfer", "bucket": "transfer", "total_cents": 25_000, "count": 1},
            {"category": "housing", "bucket": "essentials", "total_cents": 150_000, "count": 1},
            {"category": "groceries", "bucket": "essentials", "total_cents": 30_000, "count": 2},
            {"category": "dining", "bucket": "flexible", "total_cents": 8_500, "count": 1},
            {"category": "fees", "bucket": "other", "total_cents": 3_900, "count": 1},
            {
                "category": "savings_investment",
                "bucket": "savings",
                "total_cents": 40_000,
                "count": 1,
            },
        ],
    }
    assert body["category_buckets"] == dict(CATEGORY_BUCKETS)
    assert list(body["category_buckets"]) == list(CATEGORIES)


def test_the_sandbox_october_counts_income_in_only(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser, seeded_rules: Connection
) -> None:
    # Spec 007 rule 22a on the recorded Plaid sandbox item, synced and labeled
    # by the seed rules: GUSTO PAY is booked as money out (585,000) and labeled
    # income. Netting it gave the walkthrough's income of -584,578.
    link_sandbox(seeded_rules, user_a)
    body = client_as(user_a).get("/spending/summary", params=OCTOBER).json()
    assert {key: value for key, value in body.items() if key != "category_buckets"} == {
        "start": "2026-10-01",
        "end": "2026-10-31",
        "income_cents": 422,
        "essentials_cents": 540,
        "flexible_cents": 68_423,
        "savings_cents": 100_000,
        "other_cents": 0,
        "transfers_ignored_cents": 210_350,
        "income_outflows_ignored_cents": 585_000,
        "uncategorized_cents": 50_000,
        "left_over_cents": -168_541,
        # Rule 25: 68,423 and 100,000 are over ten times the 422 deposited.
        "essentials_pct": "128.0",
        "flexible_pct": None,
        "savings_rate_pct": None,
        "transaction_count": 14,
        "uncategorized_count": 1,
        "paycheck_count": 0,
        "ledger_rows_skipped": {"count": 0, "net_cents": 0},
        "account_kinds_counted": ["checking", "savings", "credit"],
        "categories": [
            {"category": "income", "bucket": "income", "total_cents": 422, "count": 1},
            {"category": "transfer", "bucket": "transfer", "total_cents": 210_350, "count": 2},
            {"category": "dining", "bucket": "flexible", "total_cents": 51_633, "count": 3},
            {"category": "transport", "bucket": "essentials", "total_cents": 540, "count": 1},
            {"category": "shopping", "bucket": "flexible", "total_cents": 58_940, "count": 2},
            {"category": "entertainment", "bucket": "flexible", "total_cents": 7_850, "count": 1},
            {"category": "travel", "bucket": "flexible", "total_cents": -50_000, "count": 1},
            {
                "category": "savings_investment",
                "bucket": "savings",
                "total_cents": 100_000,
                "count": 1,
            },
        ],
    }


def test_loan_and_investment_ledgers_are_skipped(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    # Spec 007 rule 21a, "A loan ledger": the auto loan books the 40,000 that
    # left checking as money in (labeled income) and its interest as money out.
    loan_ledger_month(db_connection, user_a)
    client = client_as(user_a)
    body = client.get("/spending/summary", params=SEPTEMBER).json()
    assert {key: value for key, value in body.items() if key != "category_buckets"} == {
        "start": "2026-09-01",
        "end": "2026-09-30",
        "income_cents": 250_000,
        "essentials_cents": 140_000,
        "flexible_cents": 0,
        "savings_cents": 0,
        "other_cents": 40_000,
        "transfers_ignored_cents": 40_000,
        "income_outflows_ignored_cents": 0,
        "uncategorized_cents": 0,
        "left_over_cents": 70_000,
        "essentials_pct": "56.0",
        "flexible_pct": "0.0",
        "savings_rate_pct": "0.0",
        "transaction_count": 6,
        "uncategorized_count": 0,
        "paycheck_count": 0,
        "ledger_rows_skipped": {"count": 3, "net_cents": -38_000},
        "account_kinds_counted": ["checking", "savings", "credit"],
        "categories": [
            {"category": "income", "bucket": "income", "total_cents": 250_000, "count": 1},
            {"category": "transfer", "bucket": "transfer", "total_cents": 40_000, "count": 2},
            {"category": "housing", "bucket": "essentials", "total_cents": 120_000, "count": 1},
            {"category": "groceries", "bucket": "essentials", "total_cents": 20_000, "count": 1},
            {"category": "debt_payment", "bucket": "other", "total_cents": 40_000, "count": 1},
        ],
    }
    # Only the money math skips the ledgers: the list still shows every row.
    listed = client.get("/transactions", params=SEPTEMBER).json()["items"]
    assert len(listed) == 9
    assert {row["merchant_raw"] for row in listed} >= {
        "Monthly payment",
        "Interest charged",
        "Dividend",
    }


def test_an_inactive_ledger_is_not_reported(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    loan = make_account(
        db_connection, user_a.id, make_item(db_connection, user_a.id), kind=AccountKind.LOAN
    )
    spend(db_connection, user_a, loan, -40_000, None)
    before = client_as(user_a).get("/spending/summary", params=SEPTEMBER).json()
    assert before["ledger_rows_skipped"] == {"count": 1, "net_cents": -40_000}
    assert before["transaction_count"] == before["uncategorized_count"] == 0
    with user_session_for(user_a.id, bind=db_connection) as session:
        session.get_one(Account, loan).is_active = False
    after = client_as(user_a).get("/spending/summary", params=SEPTEMBER).json()
    assert after["ledger_rows_skipped"] == {"count": 0, "net_cents": 0}


def test_the_dynamic_sandbox_october_skips_the_loans(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser, seeded_rules: Connection
) -> None:
    # Spec 007 rules 21a and 25 on Plaid's user_transactions_dynamic user,
    # recorded 2026-10-22 and labeled by the seed rules alone. Before them the
    # five loans' 165 posted rows made uncategorized_cents -5,498,010, and 12
    # cents of income (the paychecks were dining until spec 003 rule 4) made
    # essentials_pct "304000.0".
    link_sandbox(seeded_rules, user_a, history=DYNAMIC)
    client = client_as(user_a)
    body = client.get("/spending/summary", params=OCTOBER).json()
    assert {
        key: body[key]
        for key in (
            "income_cents",
            "essentials_cents",
            "flexible_cents",
            "savings_cents",
            "other_cents",
            "transfers_ignored_cents",
            "uncategorized_cents",
            "uncategorized_count",
            "left_over_cents",
            "transaction_count",
            "ledger_rows_skipped",
            "essentials_pct",
            "flexible_pct",
            "savings_rate_pct",
        )
    } == {
        "income_cents": 243_012,
        "essentials_cents": 36_480,
        "flexible_cents": 141_021,
        "savings_cents": 0,
        "other_cents": 0,
        "transfers_ignored_cents": 351_589,
        "uncategorized_cents": 171_202,
        "uncategorized_count": 34,
        "left_over_cents": 65_511,
        "transaction_count": 80,
        "ledger_rows_skipped": {"count": 165, "net_cents": -5_619_612},
        "essentials_pct": "15.0",
        "flexible_pct": "58.0",
        "savings_rate_pct": "0.0",
    }
    # GET /transactions is unchanged: the loans' rows are still listed.
    kinds = {row["id"]: row["kind"] for row in client.get("/accounts").json()}
    listed: list[dict[str, Any]] = []
    cursor: str | None = None
    while True:
        params: dict[str, str | int] = {**OCTOBER, "limit": 200}
        if cursor:
            params["cursor"] = cursor
        page = client.get("/transactions", params=params).json()
        listed += page["items"]
        cursor = page["next_cursor"]
        if cursor is None:
            break
    by_kind = Counter(kinds[row["account_id"]] for row in listed)
    # Every October row: 165 posted and 12 pending on the loans, 83 on the rest.
    assert (by_kind["loan"], len(listed)) == (177, 260)


def test_defaults_to_the_last_complete_month(
    frozen: FastAPI,
    client_as: Client,
    user_a: FixtureUser,
    account: uuid.UUID,
    db_connection: Connection,
) -> None:
    september(db_connection, user_a, account)
    body = client_as(user_a).get("/spending/summary").json()
    assert (body["start"], body["end"]) == ("2026-09-01", "2026-09-30")
    assert body["income_cents"] == 399_208


def test_january_defaults_to_last_december(
    app: FastAPI, client_as: Client, user_a: FixtureUser
) -> None:
    app.dependency_overrides[get_now] = lambda: dt.datetime(2027, 1, 1, 0, 0, tzinfo=dt.UTC)
    body = client_as(user_a).get("/spending/summary").json()
    assert (body["start"], body["end"]) == ("2026-12-01", "2026-12-31")


def test_inactive_accounts_are_left_out(
    frozen: FastAPI,
    client_as: Client,
    user_a: FixtureUser,
    account: uuid.UUID,
    db_connection: Connection,
) -> None:
    spend(db_connection, user_a, account, 8_500, "dining")
    with user_session_for(user_a.id, bind=db_connection) as session:
        session.get_one(Account, account).is_active = False
    body = client_as(user_a).get("/spending/summary", params=SEPTEMBER).json()
    assert (body["flexible_cents"], body["transaction_count"]) == (0, 0)


def test_an_empty_period(frozen: FastAPI, client_as: Client, user_a: FixtureUser) -> None:
    body = client_as(user_a).get("/spending/summary", params=SEPTEMBER).json()
    assert body["categories"] == []
    assert body["income_cents"] == body["left_over_cents"] == body["transaction_count"] == 0
    assert body["essentials_pct"] is None
    assert body["savings_rate_pct"] is None
    assert len(body["category_buckets"]) == len(CATEGORIES)


def test_no_income_gives_null_percentages(
    frozen: FastAPI,
    client_as: Client,
    user_a: FixtureUser,
    account: uuid.UUID,
    db_connection: Connection,
) -> None:
    spend(db_connection, user_a, account, 8_500, "dining")
    body = client_as(user_a).get("/spending/summary", params=SEPTEMBER).json()
    assert body["left_over_cents"] == -8_500
    assert (body["essentials_pct"], body["flexible_pct"], body["savings_rate_pct"]) == (
        None,
        None,
        None,
    )


def test_another_users_transactions_are_invisible(
    frozen: FastAPI,
    client_as: Client,
    user_a: FixtureUser,
    user_b: FixtureUser,
    account: uuid.UUID,
    db_connection: Connection,
) -> None:
    september(db_connection, user_a, account)
    body = client_as(user_b).get("/spending/summary", params=SEPTEMBER).json()
    assert (body["transaction_count"], body["paycheck_count"]) == (0, 0)


@pytest.mark.parametrize(
    ("params", "message"),
    [
        ({"start": "2026-09-01"}, "both"),
        ({"end": "2026-09-30"}, "both"),
        ({"start": "2026-09-30", "end": "2026-09-01"}, "after"),
        ({"start": "2025-01-01", "end": "2026-01-02"}, "366"),
        ({"start": "september", "end": "2026-09-30"}, "start"),
    ],
)
def test_bad_periods_are_422(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser, params: dict[str, str], message: str
) -> None:
    response = client_as(user_a).get("/spending/summary", params=params)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
    assert message in response.json()["error"]["message"]


def test_a_full_leap_year_is_allowed(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser
) -> None:
    response = client_as(user_a).get(
        "/spending/summary", params={"start": "2028-01-01", "end": "2028-12-31"}
    )
    assert response.status_code == 200
