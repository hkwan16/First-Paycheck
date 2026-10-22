"""GET /cashflow (spec 010 part A, route examples)."""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Connection

from app.deps import get_now
from tests.conftest import FixtureUser
from tests.support.factories import make_account, make_document, make_item, make_pay_stub
from tests.support.sandbox_history import link_sandbox
from tests.support.spending_month import loan_ledger_month, september

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


def test_september_cash_flow(
    frozen: FastAPI,
    db_connection: Connection,
    client_as: Client,
    user_a: FixtureUser,
    account: uuid.UUID,
) -> None:
    # Spec 007's month: its transactions and stubs paid 2026-09-15, 09-30 and 10-15.
    september(db_connection, user_a, account)
    client = client_as(user_a)

    response = client.get("/cashflow", params=SEPTEMBER)

    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["start"], body["end"]) == ("2026-09-01", "2026-09-30")
    assert [stub["pay_date"] for stub in body["pay_stubs"]] == ["2026-09-15", "2026-09-30"]
    assert [stub["net_cents"] for stub in body["pay_stubs"]] == [199_604, 199_604]
    total = body["withholding"]
    assert total["paycheck_count"] == 2
    assert {line["key"]: line["amount_cents"] for line in total["lines"]} == {
        "federal_withholding": 59_552,
        "social_security": 33_584,
        "medicare": 7_854,
        "state_tax": 19_628,
        "retirement_contribution": 0,
        "medical_premium": 12_500,
        "other_deductions": 9_340,
    }
    assert total["lines"][0] == {
        "key": "federal_withholding",
        "label": "Federal tax",
        "role": "tax",
        "amount_cents": 59_552,
    }
    assert total["roles"] == {
        "tax_cents": 120_618,
        "retirement_cents": 0,
        "health_cents": 12_500,
        "other_cents": 9_340,
    }
    assert (total["gross_cents"], total["deductions_cents"], total["net_cents"]) == (
        541_666,
        142_458,
        399_208,
    )
    summary = client.get("/spending/summary", params=SEPTEMBER).json()
    assert body["spending"] == summary
    assert (summary["income_cents"], summary["left_over_cents"]) == (399_208, 166_808)


def test_sandbox_income_is_never_negative(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser, seeded_rules: Connection
) -> None:
    # Spec 010 route row 4: the diagram's "Income deposited" and "Spent beyond
    # income" nodes are these two amounts, drawn as given.
    link_sandbox(seeded_rules, user_a)
    client = client_as(user_a)
    body = client.get("/cashflow", params=OCTOBER).json()
    assert body["withholding"]["paycheck_count"] == 0
    assert body["spending"] == client.get("/spending/summary", params=OCTOBER).json()
    spending = body["spending"]
    assert (
        spending["income_cents"],
        spending["income_outflows_ignored_cents"],
        spending["left_over_cents"],
    ) == (422, 585_000, -168_541)


def test_loan_ledgers_draw_no_band(
    frozen: FastAPI, db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    # Spec 010 route row 5: spec 007's loan ledger month.
    loan_ledger_month(db_connection, user_a)
    client = client_as(user_a)
    body = client.get("/cashflow", params=SEPTEMBER).json()
    assert body["spending"] == client.get("/spending/summary", params=SEPTEMBER).json()
    spending = body["spending"]
    assert (
        spending["income_cents"],
        spending["other_cents"],
        spending["left_over_cents"],
        spending["ledger_rows_skipped"],
    ) == (250_000, 40_000, 70_000, {"count": 3, "net_cents": -38_000})


def test_stub_ids_are_the_users_pay_stubs(
    frozen: FastAPI, db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    made = make_pay_stub(
        db_connection,
        user_a.id,
        make_document(db_connection, user_a.id, with_blob=False),
        pay_date=dt.date(2026, 9, 30),
    )
    body = client_as(user_a).get("/cashflow", params=SEPTEMBER).json()
    assert [stub["pay_stub_id"] for stub in body["pay_stubs"]] == [str(made)]


def test_default_period_is_last_month(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser
) -> None:
    body = client_as(user_a).get("/cashflow").json()
    assert (body["start"], body["end"]) == ("2026-09-01", "2026-09-30")
    assert body["pay_stubs"] == []
    assert body["withholding"]["paycheck_count"] == 0
    assert body["spending"]["transaction_count"] == 0


@pytest.mark.parametrize(
    "params",
    [
        {"start": "2026-09-01"},
        {"start": "2026-09-30", "end": "2026-09-01"},
        {"start": "2025-09-01", "end": "2026-09-02"},
    ],
)
def test_period_validation(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser, params: dict[str, str]
) -> None:
    response = client_as(user_a).get("/cashflow", params=params)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
