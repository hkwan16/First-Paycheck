"""GET and PATCH /accounts (spec 002 rules 30-31)."""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import Connection

from db.enums import AccountKind, AccountRole
from tests.conftest import FixtureUser
from tests.support.factories import make_account, make_item, make_snapshot

Client = Callable[[FixtureUser], TestClient]


def test_list_accounts_with_latest_balance(
    db_connection: Connection, client_as: Client, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    zeta = make_item(db_connection, user_a.id, institution_name="Zeta Credit Union")
    alpha = make_item(db_connection, user_a.id, institution_name="Alpha Bank")
    savings = make_account(
        db_connection, user_a.id, alpha, name="Savings", kind=AccountKind.SAVINGS, mask="1111"
    )
    checking = make_account(
        db_connection,
        user_a.id,
        alpha,
        name="Checking",
        role=AccountRole.SPENDING,
    )
    card = make_account(
        db_connection, user_a.id, zeta, name="Card", kind=AccountKind.CREDIT, mask=None
    )
    make_snapshot(
        db_connection,
        user_a.id,
        checking,
        balance_cents=10_000,
        as_of=dt.datetime(2026, 10, 1, tzinfo=dt.UTC),
    )
    make_snapshot(
        db_connection,
        user_a.id,
        checking,
        balance_cents=12_345,
        as_of=dt.datetime(2026, 10, 2, tzinfo=dt.UTC),
    )
    make_account(db_connection, user_b.id, make_item(db_connection, user_b.id))

    response = client_as(user_a).get("/accounts")

    assert response.status_code == 200
    accounts = response.json()
    assert [a["id"] for a in accounts] == [str(checking), str(savings), str(card)]
    assert accounts[0] == {
        "id": str(checking),
        "sync_item_id": str(alpha),
        "institution_name": "Alpha Bank",
        "name": "Checking",
        "kind": "checking",
        "mask": "0000",
        "role": "spending",
        "is_active": True,
        "balance_cents": 12_345,
        "balance_as_of": "2026-10-02T00:00:00Z",
    }
    assert (accounts[1]["balance_cents"], accounts[1]["balance_as_of"]) == (None, None)
    assert accounts[2]["mask"] is None


def test_list_accounts_empty(client_as: Client, user_a: FixtureUser) -> None:
    response = client_as(user_a).get("/accounts")
    assert (response.status_code, response.json()) == (200, [])


def account(connection: Connection, user: FixtureUser, **fields: Any) -> uuid.UUID:
    return make_account(connection, user.id, make_item(connection, user.id), **fields)


def test_patch_role_and_active(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    target = account(db_connection, user_a)
    client = client_as(user_a)

    response = client.patch(f"/accounts/{target}", json={"role": "spending"})
    assert response.status_code == 200
    assert (response.json()["role"], response.json()["is_active"]) == ("spending", True)

    response = client.patch(f"/accounts/{target}", json={"is_active": False})
    assert (response.json()["role"], response.json()["is_active"]) == ("spending", False)

    response = client.patch(f"/accounts/{target}", json={"role": None})
    assert response.json()["role"] is None


def test_empty_patch_changes_nothing(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    target = account(db_connection, user_a, role=AccountRole.RETIREMENT)
    response = client_as(user_a).patch(f"/accounts/{target}", json={})
    assert response.status_code == 200
    assert response.json()["role"] == "retirement"


def test_emergency_fund_moves(
    db_connection: Connection, client_as: Client, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    old = account(db_connection, user_a, role=AccountRole.EMERGENCY_FUND, kind=AccountKind.SAVINGS)
    new = account(db_connection, user_a, kind=AccountKind.SAVINGS)
    other_users = account(db_connection, user_b, role=AccountRole.EMERGENCY_FUND)
    client = client_as(user_a)

    response = client.patch(f"/accounts/{new}", json={"role": "emergency_fund"})

    assert response.status_code == 200
    roles = {a["id"]: a["role"] for a in client.get("/accounts").json()}
    assert roles == {str(old): None, str(new): "emergency_fund"}
    assert client_as(user_b).get("/accounts").json()[0]["id"] == str(other_users)
    assert client_as(user_b).get("/accounts").json()[0]["role"] == "emergency_fund"


def test_patch_validation(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    target = account(db_connection, user_a)
    client = client_as(user_a)
    assert client.patch(f"/accounts/{target}", json={"role": "piggy_bank"}).status_code == 422
    assert client.patch(f"/accounts/{target}", json={"is_active": None}).status_code == 422
    assert client.patch(f"/accounts/{target}", json={"name": "x"}).status_code == 422


def test_patch_unknown_account_is_404(client_as: Client, user_a: FixtureUser) -> None:
    response = client_as(user_a).patch(f"/accounts/{uuid.uuid4()}", json={"role": "spending"})
    assert response.status_code == 404
