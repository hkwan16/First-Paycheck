"""GET /net-worth and GET /holdings (spec 015 rules 20-21, route rows 5-6)."""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable
from decimal import Decimal

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Connection

from app.deps import get_now
from db.enums import AccountKind, AccountRole
from tests.conftest import FixtureUser
from tests.support.factories import make_account, make_holding, make_item, make_snapshot

Client = Callable[[FixtureUser], TestClient]
NOW = dt.datetime(2026, 11, 16, 15, 0, tzinfo=dt.UTC)


@pytest.fixture
def frozen(app: FastAPI) -> FastAPI:
    app.dependency_overrides[get_now] = lambda: NOW
    return app


def at(day: str) -> dt.datetime:
    return dt.datetime.fromisoformat(f"{day}T06:00:00+00:00")


def row_five(db_connection: Connection, user_a: FixtureUser) -> uuid.UUID:
    """Spec 015 route row 5's accounts and snapshots; returns their item."""
    item = make_item(db_connection, user_a.id, institution_name="Chase")
    accounts = {
        name: make_account(db_connection, user_a.id, item, kind=kind, name=name, **extra)
        for name, kind, extra in (
            ("Chase Total Checking", AccountKind.CHECKING, {"mask": "4821"}),
            (
                "Chase Savings",
                AccountKind.SAVINGS,
                {"mask": "7730", "role": AccountRole.EMERGENCY_FUND},
            ),
            ("Sapphire", AccountKind.CREDIT, {"mask": "1111"}),
            ("Acme 401(k)", AccountKind.RETIREMENT, {"mask": None}),
            ("Hidden", AccountKind.CHECKING, {"mask": "9999", "is_active": False}),
        )
    }
    for name, day, cents in (
        ("Chase Total Checking", "2026-09-20", 250_000),
        ("Chase Total Checking", "2026-10-20", 280_000),
        ("Chase Total Checking", "2026-11-15", 312_044),
        ("Chase Savings", "2026-09-20", 200_000),
        ("Chase Savings", "2026-10-20", 230_000),
        ("Chase Savings", "2026-11-15", 274_000),
        ("Sapphire", "2026-10-20", 45_000),
        ("Sapphire", "2026-11-15", 60_000),
        ("Acme 401(k)", "2026-11-15", 21_710),
        ("Hidden", "2026-11-15", 1_000_000),
    ):
        make_snapshot(db_connection, user_a.id, accounts[name], balance_cents=cents, as_of=at(day))
    return item


def test_net_worth_by_month(
    frozen: FastAPI, db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    row_five(db_connection, user_a)

    response = client_as(user_a).get("/net-worth", params={"months": 3})

    assert response.status_code == 200, response.text
    body = response.json()
    assert [(p["month"], p["as_of"], p["net_worth_cents"]) for p in body["series"]] == [
        ("2026-09-01", "2026-09-30", 450_000),
        ("2026-10-01", "2026-10-31", 465_000),
        ("2026-11-01", "2026-11-16", 547_754),
    ]
    assert (body["assets_cents"], body["liabilities_cents"], body["net_worth_cents"]) == (
        607_754,
        60_000,
        547_754,
    )
    assert body["change_cents"] == 97_754
    assert body["as_of"] == "2026-11-15"
    assert [(k["kind"], k["side"], k["total_cents"]) for k in body["by_kind"]] == [
        ("checking", "asset", 312_044),
        ("savings", "asset", 274_000),
        ("credit", "liability", 60_000),
        ("retirement", "asset", 21_710),
    ]
    listed = {a["name"]: a for a in body["accounts"]}
    assert set(listed) == {"Chase Total Checking", "Chase Savings", "Sapphire", "Acme 401(k)"}
    savings = listed["Chase Savings"]
    assert (savings["mask"], savings["role"], savings["institution_name"]) == (
        "7730",
        "emergency_fund",
        "Chase",
    )
    assert (listed["Sapphire"]["side"], listed["Sapphire"]["balance_as_of"]) == (
        "liability",
        "2026-11-15",
    )


def test_net_worth_counts_a_loan_as_owed(
    frozen: FastAPI, db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    # Spec 015 route row 12.
    item = row_five(db_connection, user_a)
    loan = make_account(
        db_connection, user_a.id, item, kind=AccountKind.LOAN, name="Student Loan", mask="7777"
    )
    for day, cents in (("2026-10-20", 1_210_000), ("2026-11-15", 1_200_000)):
        make_snapshot(db_connection, user_a.id, loan, balance_cents=cents, as_of=at(day))

    response = client_as(user_a).get("/net-worth", params={"months": 3})

    assert response.status_code == 200, response.text
    body = response.json()
    assert [p["net_worth_cents"] for p in body["series"]] == [450_000, -745_000, -652_246]
    assert body["change_cents"] == -1_102_246
    assert (body["assets_cents"], body["liabilities_cents"], body["net_worth_cents"]) == (
        607_754,
        1_260_000,
        -652_246,
    )
    listed = {a["name"]: a for a in body["accounts"]}
    assert (
        listed["Student Loan"]["kind"],
        listed["Student Loan"]["side"],
        listed["Student Loan"]["balance_cents"],
    ) == ("loan", "liability", 1_200_000)
    assert [(k["kind"], k["side"], k["total_cents"]) for k in body["by_kind"]] == [
        ("checking", "asset", 312_044),
        ("savings", "asset", 274_000),
        ("credit", "liability", 60_000),
        ("loan", "liability", 1_200_000),
        ("retirement", "asset", 21_710),
    ]


def test_net_worth_without_data(frozen: FastAPI, client_as: Client, user_a: FixtureUser) -> None:
    body = client_as(user_a).get("/net-worth").json()
    assert body["series"] == []
    assert (body["as_of"], body["change_cents"], body["net_worth_cents"]) == (None, None, 0)


@pytest.mark.parametrize("months", ["0", "61", "x"])
def test_net_worth_months_is_validated(
    frozen: FastAPI, client_as: Client, user_a: FixtureUser, months: str
) -> None:
    assert client_as(user_a).get("/net-worth", params={"months": months}).status_code == 422


def test_holdings_newest_per_account(
    frozen: FastAPI, db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    item = make_item(db_connection, user_a.id)
    retirement = make_account(
        db_connection, user_a.id, item, kind=AccountKind.RETIREMENT, name="Acme 401(k)", mask=None
    )
    brokerage = make_account(
        db_connection, user_a.id, item, kind=AccountKind.INVESTMENT, name="Brokerage", mask="2222"
    )
    make_account(db_connection, user_a.id, item, kind=AccountKind.CHECKING, name="Checking")
    target = {
        "security_id": "sec-vsvnx",
        "name": "Vanguard Target Retirement 2070",
        "ticker": "VSVNX",
        "quantity": Decimal("14.21"),
    }
    make_holding(
        db_connection,
        user_a.id,
        retirement,
        as_of=dt.date(2026, 11, 14),
        value_cents=20_000,
        cost_basis_cents=21_000,
        **target,
    )
    make_holding(
        db_connection,
        user_a.id,
        retirement,
        as_of=dt.date(2026, 11, 15),
        value_cents=21_710,
        cost_basis_cents=21_668,
        **target,
    )
    make_holding(db_connection, user_a.id, brokerage, as_of=dt.date(2026, 11, 15))
    make_holding(
        db_connection,
        user_a.id,
        brokerage,
        as_of=dt.date(2026, 11, 15),
        security_id="sec-vxus",
        name="Vanguard Total International Stock ETF",
        ticker="VXUS",
        value_cents=30_000,
        cost_basis_cents=None,
    )

    response = client_as(user_a).get("/holdings")

    assert response.status_code == 200, response.text
    body = response.json()
    first, second = body["accounts"]
    assert (first["name"], second["name"]) == ("Acme 401(k)", "Brokerage")
    assert (
        first["as_of"],
        first["value_cents"],
        first["cost_basis_cents"],
        first["gain_cents"],
    ) == (
        "2026-11-15",
        21_710,
        21_668,
        42,
    )
    assert first["holdings"] == [
        {
            "security_id": "sec-vsvnx",
            "name": "Vanguard Target Retirement 2070",
            "ticker": "VSVNX",
            "quantity": "14.21000000",
            "value_cents": 21_710,
            "cost_basis_cents": 21_668,
            "gain_cents": 42,
        }
    ]
    assert [h["ticker"] for h in second["holdings"]] == ["VTI", "VXUS"]
    assert (second["value_cents"], second["cost_basis_cents"], second["gain_cents"]) == (
        128_000,
        None,
        None,
    )
    assert second["mask"] == "2222"
    assert (body["value_cents"], body["cost_basis_cents"], body["gain_cents"]) == (
        149_710,
        None,
        None,
    )
