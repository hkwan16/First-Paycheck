"""GET /cashflow (spec 010 part A, route examples)."""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Connection

from app.deps import get_now
from db.enums import AccountKind, CategorySource
from tests.conftest import FixtureUser
from tests.support.factories import (
    make_account,
    make_document,
    make_item,
    make_pay_stub,
    make_transaction,
    supersede_pay_stub,
)
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


def stage_two(body: dict[str, Any]) -> list[tuple[str, str, int]]:
    """The diagram's bands into column 2: where the period's money went."""
    column = {node["id"]: node["column"] for node in body["diagram"]["nodes"]}
    return [
        (link["source"], link["target"], link["cents"])
        for link in body["diagram"]["links"]
        if column[link["target"]] == 2
    ]


def test_spending_beyond_take_home_comes_from_labeled_sources(
    frozen: FastAPI,
    db_connection: Connection,
    client_as: Client,
    user_a: FixtureUser,
    account: uuid.UUID,
) -> None:
    """Spec 010 diagram example D1, issue #236: one stub's take-home is
    1,996.04, 3,240.12 was deposited and 5,234.98 spent. Take-home was drawn
    as tall as the spending; now each node is its own amount and the rest of
    the spending comes from other deposits and from beyond the income."""
    make_pay_stub(
        db_connection,
        user_a.id,
        make_document(db_connection, user_a.id, with_blob=False),
        pay_date=dt.date(2026, 10, 15),
    )
    for raw, cents, category in [
        ("ACME PAYROLL", -199_604, "income"),
        ("SIDE GIG DEPOSIT", -124_408, "income"),
        ("PARKLINE APARTMENTS", 250_000, "housing"),
        ("SAFEWAY", 60_000, "groceries"),
        ("ZZ BISTRO", 80_000, "dining"),
        ("ZZ OUTLET", 131_344, "shopping"),
        ("ZZ BROKERAGE", 2_154, "savings_investment"),
    ]:
        make_transaction(
            db_connection,
            user_a.id,
            account,
            merchant_raw=raw,
            amount_cents=cents,
            posted_at=dt.date(2026, 10, 20),
            category=category,
            category_source=CategorySource.RULE,
        )

    body = client_as(user_a).get("/cashflow", params=OCTOBER).json()

    nodes = {node["id"]: node["cents"] for node in body["diagram"]["nodes"]}
    assert (nodes["gross"], nodes["take_home"], nodes["other_deposits"]) == (
        270_833,
        199_604,
        124_408,
    )
    assert nodes["beyond_income"] == 199_486
    assert "left_over" not in nodes
    assert stage_two(body) == [
        ("take_home", "bucket:essentials", 199_604),
        ("other_deposits", "bucket:essentials", 110_396),
        ("other_deposits", "bucket:flexible", 14_012),
        ("beyond_income", "bucket:flexible", 197_332),
        ("beyond_income", "bucket:savings", 2_154),
    ]


def test_september_diagram_is_the_summary_drawn(
    frozen: FastAPI,
    db_connection: Connection,
    client_as: Client,
    user_a: FixtureUser,
    account: uuid.UUID,
) -> None:
    """Spec 010 diagram example D2: take-home equal to the deposits."""
    september(db_connection, user_a, account)
    body = client_as(user_a).get("/cashflow", params=SEPTEMBER).json()
    assert stage_two(body) == [
        ("take_home", "bucket:essentials", 180_000),
        ("take_home", "bucket:flexible", 8_500),
        ("take_home", "bucket:savings", 40_000),
        ("take_home", "bucket:other", 3_900),
        ("take_home", "left_over", 166_808),
    ]


def test_months_with_something_to_show(
    db_connection: Connection,
    client_as: Client,
    user_a: FixtureUser,
    user_b: FixtureUser,
    account: uuid.UUID,
) -> None:
    """Spec 010 rule 5d, example M1: the picker lists only these months."""
    for posted, pending in [
        (dt.date(2026, 7, 14), False),
        (dt.date(2026, 9, 2), False),
        (dt.date(2026, 9, 20), False),
        (dt.date(2026, 6, 30), True),
    ]:
        make_transaction(db_connection, user_a.id, account, posted_at=posted, pending=pending)
    loan = make_account(
        db_connection,
        user_a.id,
        make_item(db_connection, user_a.id),
        kind=AccountKind.LOAN,
        name="Auto loan",
    )
    make_transaction(db_connection, user_a.id, loan, posted_at=dt.date(2026, 5, 5))
    old = make_pay_stub(
        db_connection,
        user_a.id,
        make_document(db_connection, user_a.id, with_blob=False),
        pay_date=dt.date(2026, 8, 14),
    )
    new = make_pay_stub(
        db_connection,
        user_a.id,
        make_document(db_connection, user_a.id, with_blob=False),
        pay_date=dt.date(2026, 10, 15),
    )
    supersede_pay_stub(db_connection, user_a.id, old, new)
    other = make_account(db_connection, user_b.id, make_item(db_connection, user_b.id))
    make_transaction(db_connection, user_b.id, other, posted_at=dt.date(2026, 4, 1))

    response = client_as(user_a).get("/spending/months")

    assert response.status_code == 200, response.text
    assert response.json() == {"months": ["2026-10-01", "2026-09-01", "2026-07-01"]}
    assert client_as(user_b).get("/spending/months").json() == {"months": ["2026-04-01"]}
