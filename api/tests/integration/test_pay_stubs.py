"""GET /pay-stubs (spec 005 rule 24)."""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable

from fastapi.testclient import TestClient
from sqlalchemy import Connection

from app.db import user_session_for
from app.routers.pay_stubs import newest_pay_stub, pay_stub_rate, pay_stub_withholding
from tests.conftest import FixtureUser
from tests.support.factories import STUB_01, make_document, make_pay_stub

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
        "annual_salary_cents",
        "retirement_contribution_pct",
    }
    assert only["gross_cents"] == 270_833
    assert only["pay_frequency"] == "semimonthly"
    assert only["pay_date"] == "2026-10-15"
    # Spec 005 rule 24a, row 1: 270,833 x 24, exact.
    assert only["annual_salary_cents"] == 6_499_992
    # Spec 005 rule 24b, row 4: the Acme stub has no retirement line.
    assert only["retirement_contribution_pct"] == "0.00"


def test_contribution_rate_of_stub_01(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    # Spec 005 rule 24b, row 1 (issue 132): 10,962 of 365,385 is 3.00.
    document = make_document(db_connection, user_a.id, with_blob=False)
    make_pay_stub(db_connection, user_a.id, document, **STUB_01)
    (only,) = client_as(user_a).get("/pay-stubs").json()
    assert only["retirement_contribution_cents"] == 10_962
    assert only["retirement_contribution_pct"] == "3.00"
    assert only["annual_salary_cents"] == 9_500_010


def test_what_the_newest_pay_stub_shows(db_connection: Connection, user_a: FixtureUser) -> None:
    """What POST /explain states beside the chosen 401(k) rate and the W-4 entries'
    withholding (spec 008 rules 7a and 7b)."""
    with user_session_for(user_a.id, bind=db_connection) as session:
        none = newest_pay_stub(session)
        assert none is None
        assert pay_stub_rate(none) is None
        assert pay_stub_withholding(none, 26) is None
    document = make_document(db_connection, user_a.id, with_blob=False)
    make_pay_stub(db_connection, user_a.id, document, **STUB_01)
    newer = make_document(db_connection, user_a.id, with_blob=False)
    make_pay_stub(
        db_connection,
        user_a.id,
        newer,
        **{
            **STUB_01,
            "pay_date": dt.date(2026, 4, 24),
            "period_start": dt.date(2026, 4, 6),
            "period_end": dt.date(2026, 4, 19),
            "retirement_contribution_cents": 0,
            "net_cents": STUB_01["net_cents"] + STUB_01["retirement_contribution_cents"],
            "federal_withholding_cents": 0,
            "state_tax_cents": STUB_01["state_tax_cents"] + STUB_01["federal_withholding_cents"],
        },
    )
    with user_session_for(user_a.id, bind=db_connection) as session:
        newest = newest_pay_stub(session)
        assert str(pay_stub_rate(newest)) == "0.00"
        # A confirmed 0 is withheld; a biweekly stub says nothing of a semimonthly year.
        assert pay_stub_withholding(newest, 26) == 0
        assert pay_stub_withholding(newest, 24) is None


def test_annual_salary_is_null_without_a_pay_frequency(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    document = make_document(db_connection, user_a.id, with_blob=False)
    make_pay_stub(db_connection, user_a.id, document, pay_frequency=None)
    (only,) = client_as(user_a).get("/pay-stubs").json()
    assert only["pay_frequency"] is None
    assert only["annual_salary_cents"] is None


def test_no_stubs(client_as: Client, user_a: FixtureUser) -> None:
    assert client_as(user_a).get("/pay-stubs").json() == []
