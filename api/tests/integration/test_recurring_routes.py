"""GET /recurring and PATCH /recurring/{id} (spec 009 rules 17-18, route examples)."""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Connection, text

from db.enums import RecurringCadence, RecurringStatus, RecurringUserStatus
from tests.conftest import FixtureUser
from tests.support.factories import make_recurring_charge

Client = Callable[[FixtureUser], TestClient]


@pytest.fixture
def netflix(db_connection: Connection, user_a: FixtureUser) -> uuid.UUID:
    return make_recurring_charge(db_connection, user_a.id)


def stored(connection: Connection, charge: uuid.UUID) -> dict[str, Any]:
    row = connection.execute(
        text(
            "SELECT merchant_clean, status::text AS status, user_status::text AS user_status"
            " FROM recurring_charges WHERE id = :id"
        ),
        {"id": charge},
    ).one()
    return dict(row._mapping)


def test_lists_every_charge_in_name_order(
    db_connection: Connection, client_as: Client, user_a: FixtureUser, netflix: uuid.UUID
) -> None:
    gym = make_recurring_charge(
        db_connection,
        user_a.id,
        merchant_norm="core power yoga",
        merchant_clean="Core Power Yoga",
        cadence=RecurringCadence.WEEKLY,
        typical_amount_cents=2000,
        first_seen=dt.date(2026, 9, 1),
        last_seen=dt.date(2026, 9, 22),
        user_status=RecurringUserStatus.IGNORED,
        status=RecurringStatus.STOPPED,
    )

    response = client_as(user_a).get("/recurring")

    assert response.status_code == 200, response.text
    items = response.json()
    assert [item["id"] for item in items] == [str(gym), str(netflix)]
    first = items[0]
    assert {key: first[key] for key in first if key not in {"id", "updated_at"}} == {
        "merchant_norm": "core power yoga",
        "merchant_clean": "Core Power Yoga",
        "cadence": "weekly",
        "typical_amount_cents": 2000,
        "first_seen": "2026-09-01",
        "last_seen": "2026-09-22",
        "status": "stopped",
        "user_status": "ignored",
    }
    assert first["updated_at"].endswith("Z")


def test_empty_list(client_as: Client, user_a: FixtureUser) -> None:
    response = client_as(user_a).get("/recurring")
    assert (response.status_code, response.json()) == (200, [])


def test_patch_marks_ignored_and_renames(
    db_connection: Connection, client_as: Client, user_a: FixtureUser, netflix: uuid.UUID
) -> None:
    response = client_as(user_a).patch(
        f"/recurring/{netflix}", json={"user_status": "ignored", "merchant_clean": " Netflix "}
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["user_status"], body["merchant_clean"], body["status"]) == (
        "ignored",
        "Netflix",
        "new",
    )
    assert stored(db_connection, netflix) == {
        "merchant_clean": "Netflix",
        "status": "new",
        "user_status": "ignored",
    }


def test_patch_null_clears_the_user_status(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    charge = make_recurring_charge(
        db_connection, user_a.id, user_status=RecurringUserStatus.CANCELLED
    )
    response = client_as(user_a).patch(f"/recurring/{charge}", json={"user_status": None})
    assert response.status_code == 200, response.text
    assert stored(db_connection, charge)["user_status"] is None


def test_omitted_fields_are_unchanged(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    charge = make_recurring_charge(
        db_connection, user_a.id, user_status=RecurringUserStatus.CONFIRMED
    )
    client = client_as(user_a)
    assert client.patch(f"/recurring/{charge}", json={"merchant_clean": "Netflix"}).is_success
    assert client.patch(f"/recurring/{charge}", json={}).is_success
    assert stored(db_connection, charge) == {
        "merchant_clean": "Netflix",
        "status": "new",
        "user_status": "confirmed",
    }


@pytest.mark.parametrize(
    "body",
    [
        {"merchant_clean": "   "},
        {"merchant_clean": None},
        {"merchant_clean": "x" * 101},
        {"status": "active"},
        {"user_status": "paused"},
    ],
)
def test_patch_validation(
    db_connection: Connection,
    client_as: Client,
    user_a: FixtureUser,
    netflix: uuid.UUID,
    body: dict[str, Any],
) -> None:
    response = client_as(user_a).patch(f"/recurring/{netflix}", json=body)
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "validation_error"
    assert stored(db_connection, netflix)["merchant_clean"] == "NETFLIX.COM"


def test_patch_unknown_charge_is_404(client_as: Client, user_a: FixtureUser) -> None:
    response = client_as(user_a).patch(f"/recurring/{uuid.uuid4()}", json={"user_status": None})
    assert response.status_code == 404
