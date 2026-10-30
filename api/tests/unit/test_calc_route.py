"""POST /calc/*: the stateless calculators (specs 006, 011, 012 and 014) over HTTP."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from tests.support.tokens import make_token
from tests.unit.calc.test_health_plans_examples import A, B, payload

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


EMERGENCY_FUND: dict[str, Any] = {
    "monthly_essentials_cents": 250_000,
    "target_months": 3,
    "current_balance_cents": 0,
    "monthly_contribution_cents": 50_000,
    "pay_periods_per_year": 26,
}


def test_emergency_fund_over_http(client: TestClient) -> None:
    response = client.post("/calc/emergency-fund", json=EMERGENCY_FUND)
    assert response.status_code == 200, response.text
    assert response.json() == {
        "target_cents": 750_000,
        "three_month_target_cents": 750_000,
        "six_month_target_cents": 1_500_000,
        "shortfall_cents": 750_000,
        "funded": False,
        "funded_pct": "0.00",
        "months_to_target": 15,
        "reachable": True,
        "per_paycheck_contribution_cents": 23_077,
        "horizon_months": 120,
    }


def test_emergency_fund_rejects_a_zero_month_target(client: TestClient) -> None:
    response = client.post("/calc/emergency-fund", json={**EMERGENCY_FUND, "target_months": 0})
    assert response.status_code == 422
    assert "target_months" in response.json()["error"]["message"]


def test_health_plans_over_http(client: TestClient) -> None:
    response = client.post("/calc/health-plans", json=payload([A, B], 6_500_000, 100_000))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["marginal_rate_used"] == "12.00"
    assert body["plans"][0]["medium_cost_cents"] == 174_000
    assert body["pairs"] == [
        {
            "plan_a_index": 0,
            "plan_b_index": 1,
            "cheaper_at_zero_index": 0,
            "break_even_spends_cents": [940_000, 1_710_000],
            "cheaper_at_end_index": 0,
        }
    ]


def test_health_plans_refuses_employer_hsa_on_a_ppo(client: TestClient) -> None:
    plan = {**B, "employer_hsa_cents": 100}
    response = client.post("/calc/health-plans", json=payload([plan], 6_500_000, 0))
    assert response.status_code == 422
    assert "employer_hsa_cents" in response.json()["error"]["message"]


W4_EXAMPLE_5: dict[str, Any] = {
    "salary_cents": 5_000_000,
    "pay_periods_per_year": 26,
    "filing_status": "single",
    "tax_year": 2026,
    "other_jobs_wages_cents": 2_000_000,
    "other_jobs_withholding_cents": 39_000,
}


def test_w4_over_http(client: TestClient) -> None:
    """Spec 014 example 13 (example 5 with a stub withholding $147.00), with the
    defaults filled in by the model."""
    response = client.post(
        "/calc/w4", json={**W4_EXAMPLE_5, "current_withholding_per_paycheck_cents": 14_700}
    )
    assert response.status_code == 200, response.text
    assert response.json() == {
        "k401_annual_cents": 0,
        "k401_capped": False,
        "health_premium_annual_cents": 0,
        "taxable_wages_per_paycheck_cents": 192_308,
        "adjusted_annual_wage_cents": 4_140_000,
        "withholding_schedule": "standard",
        "withholding_rate_pct": "12.00",
        "withholding_per_paycheck_cents": 14_692,
        "annual_withholding_cents": 381_992,
        "projected_taxable_income_cents": 5_390_000,
        "projected_tax_cents": 657_000,
        "projected_tax_after_credits_cents": 657_000,
        "projected_refund_cents": -236_008,
        "current_annual_withholding_cents": 382_200,
        "current_refund_cents": -235_800,
        "suggestion": "increase_extra_withholding",
        "suggested_extra_withholding_cents": 9_100,
        "suggested_deductions_cents": 0,
        "suggested_refund_cents": 592,
        "citation_keys": [
            "w4.percentage_method",
            "w4.form_adjustments",
            "w4.standard_deduction",
            "w4.federal_brackets",
            "w4.multiple_jobs",
        ],
    }


@pytest.mark.parametrize(
    ("change", "fragment"),
    [
        ({"tax_year": 2027}, "2027"),
        ({"health_premium_per_paycheck_cents": 200_000}, "exceed the salary"),
        ({"extra_withholding_cents": 10.5}, "extra_withholding_cents"),
    ],
)
def test_w4_invalid_input_is_422(client: TestClient, change: dict[str, Any], fragment: str) -> None:
    response = client.post("/calc/w4", json={**W4_EXAMPLE_5, **change})
    assert response.status_code == 422
    assert fragment in response.json()["error"]["message"]


def test_w4_requires_a_signed_in_user() -> None:
    response = TestClient(create_app()).post("/calc/w4", json=W4_EXAMPLE_5)
    assert response.status_code == 401
