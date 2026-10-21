"""GET and PUT /profile (spec 005 rule 25)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Connection, text

from tests.conftest import FixtureUser

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
}


def test_defaults_before_anything_is_saved(client_as: Client, user_a: FixtureUser) -> None:
    response = client_as(user_a).get("/profile")
    assert response.status_code == 200
    assert response.json() == {**DEFAULTS, "updated_at": None}


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
        **DEFAULTS,
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
    assert client_as(user_b).get("/profile").json() == {**DEFAULTS, "updated_at": None}
