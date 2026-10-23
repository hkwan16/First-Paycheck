"""GET /spending/summary on a hand-built month (spec 007 part B)."""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Connection

from app.db import user_session_for
from app.deps import get_now
from db.models import Account
from sync.categories import CATEGORIES, CATEGORY_BUCKETS
from tests.conftest import FixtureUser
from tests.support.factories import (
    make_account,
    make_item,
)
from tests.support.sandbox_history import link_sandbox
from tests.support.spending_month import september, spend

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
    # income. Netting it gave the walkthrough's income of -584,578. The United
    # Airlines refund (-50,000, money in) is uncategorized: the seed rule
    # `united airlines` is a spending rule and labels money out only (spec 003
    # rule 3b), so it no longer nets travel.
    link_sandbox(seeded_rules, user_a)
    body = client_as(user_a).get("/spending/summary", params=OCTOBER).json()
    assert {key: value for key, value in body.items() if key != "category_buckets"} == {
        "start": "2026-10-01",
        "end": "2026-10-31",
        "income_cents": 422,
        "essentials_cents": 540,
        "flexible_cents": 118_423,
        "savings_cents": 100_000,
        "other_cents": 0,
        "transfers_ignored_cents": 210_350,
        "income_outflows_ignored_cents": 585_000,
        "uncategorized_cents": 0,
        "left_over_cents": -218_541,
        "essentials_pct": "128.0",
        "flexible_pct": "28062.3",
        "savings_rate_pct": "23696.7",
        "transaction_count": 14,
        "uncategorized_count": 2,
        "paycheck_count": 0,
        "categories": [
            {"category": "income", "bucket": "income", "total_cents": 422, "count": 1},
            {"category": "transfer", "bucket": "transfer", "total_cents": 210_350, "count": 2},
            {"category": "dining", "bucket": "flexible", "total_cents": 51_633, "count": 3},
            {"category": "transport", "bucket": "essentials", "total_cents": 540, "count": 1},
            {"category": "shopping", "bucket": "flexible", "total_cents": 58_940, "count": 2},
            {"category": "entertainment", "bucket": "flexible", "total_cents": 7_850, "count": 1},
            {
                "category": "savings_investment",
                "bucket": "savings",
                "total_cents": 100_000,
                "count": 1,
            },
        ],
    }


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
