"""GET and PATCH /accounts (spec 002 rules 30-31c)."""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Connection, text
from sqlalchemy.exc import IntegrityError

from db.enums import ROLES_BY_KIND, AccountKind, AccountRole
from tests.conftest import FixtureUser
from tests.support.factories import (
    make_account,
    make_csv_item,
    make_item,
    make_snapshot,
    make_transaction,
)

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
        "allowed_roles": ["spending", "emergency_fund"],
        "is_active": True,
        "provider": "plaid",
        "balance_cents": 12_345,
        "balance_as_of": "2026-10-02T00:00:00Z",
        "transaction_count": 0,
        "first_posted_at": None,
    }
    assert (accounts[1]["balance_cents"], accounts[1]["balance_as_of"]) == (None, None)
    assert accounts[2]["mask"] is None


def test_list_accounts_names_each_provider(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    """A CSV account cannot be synced on demand, so the client must tell it apart."""
    linked = make_account(
        db_connection, user_a.id, make_item(db_connection, user_a.id, institution_name="Alpha")
    )
    imported = make_account(
        db_connection, user_a.id, make_csv_item(db_connection, user_a.id, institution_name="Beta")
    )

    response = client_as(user_a).get("/accounts")

    assert response.status_code == 200
    providers = {a["id"]: a["provider"] for a in response.json()}
    assert providers == {str(linked): "plaid", str(imported): "csv"}


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
    target = account(
        db_connection, user_a, role=AccountRole.RETIREMENT, kind=AccountKind.RETIREMENT
    )
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


def test_each_account_counts_its_transactions(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    """Rule 30a: the count is the API's, never a page of rows, so an account with
    more than 200 transactions says how many it has (issue 241's Link check)."""
    item = make_item(db_connection, user_a.id)
    busy = make_account(db_connection, user_a.id, item, name="Busy")
    make_account(db_connection, user_a.id, item, name="Quiet", provider_account_id="q")
    for day in range(205):
        make_transaction(
            db_connection,
            user_a.id,
            busy,
            posted_at=dt.date(2026, 3, 1) + dt.timedelta(days=day),
            pending=day == 204,
        )

    accounts = {a["name"]: a for a in client_as(user_a).get("/accounts").json()}

    assert (accounts["Busy"]["transaction_count"], accounts["Busy"]["first_posted_at"]) == (
        205,
        "2026-03-01",
    )
    assert (accounts["Quiet"]["transaction_count"], accounts["Quiet"]["first_posted_at"]) == (
        0,
        None,
    )


ALLOWED = {
    "checking": ["spending", "emergency_fund"],
    "savings": ["emergency_fund"],
    "credit": ["spending"],
    "loan": [],
    "investment": ["retirement"],
    "retirement": ["retirement"],
}


def test_each_kind_lists_the_roles_it_can_have(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    """Rule 31a's table, in account_role order."""
    item = make_item(db_connection, user_a.id)
    for kind in AccountKind:
        make_account(
            db_connection, user_a.id, item, kind=kind, name=kind.value, provider_account_id=kind
        )
    listed = {a["kind"]: a["allowed_roles"] for a in client_as(user_a).get("/accounts").json()}
    assert listed == ALLOWED
    assert {
        kind.value: [role.value for role in roles] for kind, roles in ROLES_BY_KIND.items()
    } == (ALLOWED)


@pytest.mark.parametrize(
    ("kind", "role"),
    [
        (AccountKind.LOAN, "spending"),
        (AccountKind.LOAN, "emergency_fund"),
        (AccountKind.LOAN, "retirement"),
        (AccountKind.CREDIT, "emergency_fund"),
        (AccountKind.SAVINGS, "retirement"),
        (AccountKind.INVESTMENT, "emergency_fund"),
        (AccountKind.RETIREMENT, "spending"),
    ],
)
def test_a_role_the_kind_does_not_allow_is_refused(
    db_connection: Connection, client_as: Client, user_a: FixtureUser, kind: AccountKind, role: str
) -> None:
    """Issue 241: a loan was offered Spending, Emergency fund and Retirement."""
    target = account(db_connection, user_a, kind=kind)
    response = client_as(user_a).patch(f"/accounts/{target}", json={"role": role})
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "role_not_allowed"
    assert client_as(user_a).get("/accounts").json()[0]["role"] is None


def test_clearing_a_role_keeps_the_account_active(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    """Rule 31b: a role once set can be cleared (issue 241)."""
    target = account(
        db_connection, user_a, kind=AccountKind.SAVINGS, role=AccountRole.EMERGENCY_FUND
    )
    response = client_as(user_a).patch(
        f"/accounts/{target}", json={"role": None, "is_active": True}
    )
    assert response.status_code == 200, response.text
    assert (response.json()["role"], response.json()["is_active"]) == (None, True)


@pytest.mark.parametrize("kind", list(AccountKind))
@pytest.mark.parametrize("role", list(AccountRole))
def test_the_database_holds_each_role_to_its_kinds(
    db_connection: Connection, user_a: FixtureUser, kind: AccountKind, role: AccountRole
) -> None:
    """ck_accounts_role_fits_kind agrees with ROLES_BY_KIND (rule 31a)."""
    target = account(db_connection, user_a, kind=kind)
    set_role = text("UPDATE accounts SET role = CAST(:role AS account_role) WHERE id = :id")
    savepoint = db_connection.begin_nested()
    if role in ROLES_BY_KIND[kind]:
        db_connection.execute(set_role, {"role": role.value, "id": target})
        savepoint.rollback()
        return
    with pytest.raises(IntegrityError, match="ck_accounts_role_fits_kind"):
        db_connection.execute(set_role, {"role": role.value, "id": target})
    savepoint.rollback()
