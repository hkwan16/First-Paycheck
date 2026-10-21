"""GET /pay-stubs (spec 005 rule 24)."""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable

from fastapi.testclient import TestClient
from sqlalchemy import Connection

from tests.conftest import FixtureUser
from tests.support.factories import make_document, make_pay_stub

Client = Callable[[FixtureUser], TestClient]


def stub(connection: Connection, user: FixtureUser, pay_date: dt.date) -> str:
    document = make_document(connection, user.id, with_blob=False)
    return str(
        make_pay_stub(
            connection,
            user.id,
            document,
            pay_date=pay_date,
            period_start=pay_date - dt.timedelta(days=14),
            period_end=pay_date,
        )
    )


def test_newest_pay_date_first(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    october = stub(db_connection, user_a, dt.date(2026, 10, 15))
    december = stub(db_connection, user_a, dt.date(2026, 12, 31))
    january = stub(db_connection, user_a, dt.date(2027, 1, 15))
    response = client_as(user_a).get("/pay-stubs")
    assert response.status_code == 200
    stubs = response.json()
    assert [s["id"] for s in stubs] == [january, december, october]
    assert [s["tax_year"] for s in stubs] == [2027, 2026, 2026]


def test_every_column_is_returned(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    stub(db_connection, user_a, dt.date(2026, 10, 15))
    (only,) = client_as(user_a).get("/pay-stubs").json()
    assert set(only) == {
        "id",
        "document_id",
        "employer_name",
        "pay_frequency",
        "pay_date",
        "tax_year",
        "period_start",
        "period_end",
        "gross_cents",
        "federal_withholding_cents",
        "social_security_cents",
        "medicare_cents",
        "state_tax_cents",
        "retirement_contribution_cents",
        "medical_premium_cents",
        "other_deductions_cents",
        "net_cents",
        "created_at",
    }
    assert only["gross_cents"] == 270_833
    assert only["pay_frequency"] == "semimonthly"
    assert only["pay_date"] == "2026-10-15"


def test_no_stubs(client_as: Client, user_a: FixtureUser) -> None:
    assert client_as(user_a).get("/pay-stubs").json() == []
