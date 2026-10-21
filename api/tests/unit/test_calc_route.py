"""POST /calc/401k-match: the stateless spec 006 calculator over HTTP."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from tests.support.tokens import make_token

USER = uuid.UUID("00000000-0000-4000-8000-0000000ca1c0")

EXAMPLE_1: dict[str, Any] = {
    "salary_cents": 6_000_000,
    "pay_periods_per_year": 26,
    "match_tiers": [
        {"employee_pct_upto": "3", "employer_pct": "100"},
        {"employee_pct_upto": "5", "employer_pct": "50"},
    ],
    "contribution_pct": "3",
    "tax_year": 2026,
    "filing_status": "single",
    "age": 30,
}


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(), headers={"Authorization": f"Bearer {make_token(USER)}"})


def test_example_1_over_http(client: TestClient) -> None:
    response = client.post("/calc/401k-match", json=EXAMPLE_1)
    assert response.status_code == 200, response.text
    assert response.json() == {
        "full_match_pct": "5.00",
        "employer_match_cents_current": 180_000,
        "employer_match_cents_full": 240_000,
        "missed_cents": 60_000,
        "employee_annual_cents_current": 180_000,
        "employee_annual_cents_full": 300_000,
        "per_paycheck_cost_delta_cents": 4_615,
        "per_paycheck_after_tax_cost_cents": 4_062,
        "marginal_rate_used": "12.00",
        "deferral_limit_cents": 2_450_000,
        "capped": False,
        "compensation_capped": False,
        "citation_keys": [
            "k401.employer_match",
            "k401.pretax_deferral",
            "k401.deferral_limit",
            "k401.federal_brackets",
        ],
    }


def test_json_numbers_are_accepted_for_percentages(client: TestClient) -> None:
    body = {**EXAMPLE_1, "contribution_pct": 4.5}
    response = client.post("/calc/401k-match", json=body)
    assert response.status_code == 200, response.text


@pytest.mark.parametrize(
    ("change", "fragment"),
    [
        ({"tax_year": 2027}, "2027"),
        ({"salary_cents": "6000000"}, "salary_cents"),
        ({"pay_periods_per_year": 25}, "pay_periods_per_year"),
        ({"extra": True}, "extra"),
    ],
)
def test_invalid_input_is_422(client: TestClient, change: dict[str, Any], fragment: str) -> None:
    response = client.post("/calc/401k-match", json={**EXAMPLE_1, **change})
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert fragment in error["message"]


def test_requires_a_signed_in_user() -> None:
    response = TestClient(create_app()).post("/calc/401k-match", json=EXAMPLE_1)
    assert response.status_code == 401
