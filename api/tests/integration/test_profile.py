"""GET and PUT /profile (spec 005 rule 25)."""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Connection, text

from app.deps import get_now
from tests.conftest import FixtureUser
from tests.support.pay_stub_copies import STUB_01, confirm_stub, replaced_late_october

Client = Callable[[FixtureUser], TestClient]

DEFAULTS: dict[str, Any] = {
    "salary_cents": None,
    "pay_frequency": None,
    "filing_status": None,
    "other_jobs": [],
    "dependents": 0,
    "expected_healthcare_usage": None,
    "start_date": None,
    "match_tiers": [],
    "vesting_years": None,
    "birth_year": None,
    "salary_pay_stub_id": None,
}
# The request clock: 08:00 EDT on October 21, 2026.
NOW = dt.datetime(2026, 10, 21, 12, 0, tzinfo=dt.UTC)
# What GET and PUT add on read: the pay schedule (rule 25a), none without a stub or an
# entry, the salary check (rule 24c), none without a salary and a stub that disagree,
# and the zone the browser reported with the person's today (spec 019 rules 2 and 5).
OUT_DEFAULTS: dict[str, Any] = {
    **DEFAULTS,
    "pay_schedule": None,
    "salary_review": None,
    "time_zone": None,
    "today": "2026-10-21",
}
FULL: dict[str, Any] = {
    "salary_cents": 6_500_000,
    "pay_frequency": "semimonthly",
    "filing_status": "single",
    "other_jobs": [{"annual_wages_cents": 1_200_000}],
    "dependents": 1,
    "expected_healthcare_usage": "low",
    "start_date": "2026-09-01",
    "match_tiers": [
        {"employee_pct_upto": "3", "employer_pct": "100"},
        {"employee_pct_upto": "5.5", "employer_pct": "50"},
    ],
    "vesting_years": 3,
    "birth_year": 2001,
}


@pytest.fixture(autouse=True)
def _frozen(app: FastAPI) -> None:
    app.dependency_overrides[get_now] = lambda: NOW


def test_defaults_before_anything_is_saved(client_as: Client, user_a: FixtureUser) -> None:
    response = client_as(user_a).get("/profile")
    assert response.status_code == 200
    assert response.json() == {**OUT_DEFAULTS, "updated_at": None}


def test_put_then_get(db_connection: Connection, client_as: Client, user_a: FixtureUser) -> None:
    client = client_as(user_a)
    saved = client.put("/profile", json=FULL)
    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert body["match_tiers"] == [
        {"employee_pct_upto": "3.00", "employer_pct": "100.00"},
        {"employee_pct_upto": "5.50", "employer_pct": "50.00"},
    ]
    assert body["updated_at"] is not None
    assert client.get("/profile").json() == body
    stored = db_connection.execute(
        text("SELECT salary_cents, match_tiers FROM profiles WHERE user_id = :u"), {"u": user_a.id}
    ).one()
    assert stored.salary_cents == 6_500_000
    assert stored.match_tiers[1] == {"employee_pct_upto": "5.50", "employer_pct": "50.00"}


def test_put_replaces_the_whole_profile(client_as: Client, user_a: FixtureUser) -> None:
    client = client_as(user_a)
    assert client.put("/profile", json=FULL).status_code == 200
    replaced = client.put("/profile", json={"salary_cents": 7_000_000})
    assert replaced.status_code == 200
    assert {k: v for k, v in replaced.json().items() if k != "updated_at"} == {
        **OUT_DEFAULTS,
        "salary_cents": 7_000_000,
    }


@pytest.mark.parametrize(
    "change",
    [
        {"salary_cents": 0},
        {"salary_cents": "6500000"},
        {"salary_cents": 65_000.5},
        {"pay_frequency": "daily"},
        {"filing_status": "married"},
        {"expected_healthcare_usage": "none"},
        {"dependents": 21},
        {"dependents": -1},
        {"vesting_years": 11},
        {"other_jobs": [{"annual_wages_cents": 0}]},
        {"other_jobs": [{"annual_wages_cents": 100}] * 6},
        {"match_tiers": [{"employee_pct_upto": "0", "employer_pct": "50"}]},
        {"match_tiers": [{"employee_pct_upto": "6", "employer_pct": "100.01"}]},
        {"match_tiers": [{"employee_pct_upto": "6.125", "employer_pct": "50"}]},
        {
            "match_tiers": [
                {"employee_pct_upto": "6", "employer_pct": "50"},
                {"employee_pct_upto": "6", "employer_pct": "25"},
            ]
        },
        {"match_tiers": [{"employee_pct_upto": str(n), "employer_pct": "10"} for n in range(1, 7)]},
        {"start_date": "September 1"},
        {"birth_year": 1899},
        {"birth_year": 3000},
        {"birth_year": "2001"},
        {"salary_pay_stub_id": "not-a-uuid"},
        {"surprise": True},
    ],
)
def test_put_validates(client_as: Client, user_a: FixtureUser, change: dict[str, Any]) -> None:
    client = client_as(user_a)
    response = client.put("/profile", json={**FULL, **change})
    assert response.status_code == 422, response.text
    assert client.get("/profile").json()["updated_at"] is None


def test_profiles_are_per_user(client_as: Client, user_a: FixtureUser, user_b: FixtureUser) -> None:
    assert client_as(user_a).put("/profile", json=FULL).status_code == 200
    assert client_as(user_b).get("/profile").json() == {**OUT_DEFAULTS, "updated_at": None}


def test_birth_year_up_to_the_current_year(
    app: FastAPI, client_as: Client, user_a: FixtureUser
) -> None:
    """Spec 006 open question 2: the year the user was born, never in the future."""
    app.dependency_overrides[get_now] = lambda: dt.datetime(2026, 10, 21, 12, 0, tzinfo=dt.UTC)
    client = client_as(user_a)
    assert client.put("/profile", json={"birth_year": 2027}).status_code == 422
    saved = client.put("/profile", json={"birth_year": 2026})
    assert saved.status_code == 200, saved.text
    assert client.get("/profile").json()["birth_year"] == 2026


# ---------------------------------------------------------------- pay schedule (rule 25a)


def test_pay_schedule_is_the_newest_stubs(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    """Issue 198: plan details saved at every two weeks, the Acme stub paid twice a month.

    The stub a Replace corrected was confirmed paid later (2026-10-31); it is
    superseded, so the schedule names the current one's 2026-10-15.
    """
    client = client_as(user_a)
    replaced_late_october(client, db_connection, user_a)
    schedule = {
        "frequency": "semimonthly",
        "periods_per_year": 24,
        "source": "pay_stub",
        "pay_stub_date": "2026-10-15",
    }
    saved = client.put("/profile", json={**FULL, "pay_frequency": "biweekly"})
    assert saved.status_code == 200, saved.text
    assert saved.json()["pay_frequency"] == "biweekly"
    assert saved.json()["pay_schedule"] == schedule
    assert client.get("/profile").json()["pay_schedule"] == schedule


def test_pay_schedule_falls_back_to_the_profile(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    assert client.put("/profile", json={**FULL, "pay_frequency": "weekly"}).status_code == 200
    weekly = {
        "frequency": "weekly",
        "periods_per_year": 52,
        "source": "profile",
        "pay_stub_date": None,
    }
    assert client.get("/profile").json()["pay_schedule"] == weekly

    # A newest stub that prints no schedule leaves the profile's in place.
    confirm_stub(client, db_connection, user_a, pay_frequency=None)
    assert client.get("/profile").json()["pay_schedule"] == weekly


def test_pay_schedule_from_a_stub_before_any_profile(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    confirm_stub(client, db_connection, user_a)
    body = client.get("/profile").json()
    assert body["updated_at"] is None
    assert body["pay_schedule"] == {
        "frequency": "semimonthly",
        "periods_per_year": 24,
        "source": "pay_stub",
        "pay_stub_date": "2026-10-15",
    }


# ---------------------------------------------------------------- salary check (rule 24c)

# Issue 221's account: plan details saved from stub-01, then the Acme stub confirmed.
ISSUE_221_PROFILE: dict[str, Any] = {**FULL, "salary_cents": 9_500_010, "pay_frequency": None}


def test_salary_review_after_a_newer_stub(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    stub_01 = confirm_stub(client, db_connection, user_a, **STUB_01)
    saved = client.put("/profile", json={**ISSUE_221_PROFILE, "salary_pay_stub_id": str(stub_01)})
    assert saved.status_code == 200, saved.text
    assert saved.json()["salary_pay_stub_id"] == str(stub_01)
    assert saved.json()["salary_review"] is None

    acme = confirm_stub(client, db_connection, user_a)
    review = {
        "pay_stub_id": str(acme),
        "pay_stub_date": "2026-10-15",
        "frequency": "semimonthly",
        "periods_per_year": 24,
        "gross_cents": 270_833,
        "annual_salary_cents": 6_499_992,
        "salary_cents": 9_500_010,
    }
    assert client.get("/profile").json()["salary_review"] == review

    # Keep $95,000.10: the salary stays, the stub it was compared with is the Acme stub.
    kept = client.put("/profile", json={**ISSUE_221_PROFILE, "salary_pay_stub_id": str(acme)})
    assert kept.status_code == 200, kept.text
    assert (kept.json()["salary_cents"], kept.json()["salary_review"]) == (9_500_010, None)

    # Use $64,999.92 instead.
    used = client.put(
        "/profile",
        json={**ISSUE_221_PROFILE, "salary_cents": 6_499_992, "salary_pay_stub_id": str(acme)},
    )
    assert used.status_code == 200, used.text
    assert client.get("/profile").json()["salary_review"] is None


def test_salary_review_survives_a_copy_of_the_stub(
    db_connection: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    """Kept against the Acme stub; a second copy of it (rule 22b) asks nothing."""
    client = client_as(user_a)
    acme = confirm_stub(client, db_connection, user_a)
    saved = client.put("/profile", json={**ISSUE_221_PROFILE, "salary_pay_stub_id": str(acme)})
    assert saved.status_code == 200, saved.text
    confirm_stub(client, db_connection, user_a)
    assert client.get("/profile").json()["salary_review"] is None


def test_salary_pay_stub_must_exist(client_as: Client, user_a: FixtureUser) -> None:
    client = client_as(user_a)
    response = client.put("/profile", json={**FULL, "salary_pay_stub_id": str(uuid.uuid4())})
    assert response.status_code == 404, response.text
    assert response.json()["error"]["code"] == "not_found"
    assert client.get("/profile").json()["updated_at"] is None
