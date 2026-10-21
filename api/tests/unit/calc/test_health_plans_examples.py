"""Spec 012 hand-worked examples: one test per row, named as in the spec.

Tax year 2026, single, 26 pay periods, the default usage scenarios and
medium expected usage unless stated.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest
from pydantic import ValidationError

from calc.health_plans import (
    HDHP_CITATION_KEYS,
    SCAN_STEP_CENTS,
    HealthPlansInput,
    HealthPlansResult,
    health_plans,
)

A = {
    "name": "Bronze HSA",
    "kind": "hdhp",
    "premium_per_period_cents": 2_500,
    "deductible_cents": 170_000,
    "coinsurance_pct": "20",
    "oop_max_cents": 400_000,
    "employer_hsa_cents": 75_000,
}
A_LOW_DEDUCTIBLE = {**A, "deductible_cents": 150_000}
B = {
    "name": "Gold PPO",
    "kind": "ppo",
    "premium_per_period_cents": 6_250,
    "deductible_cents": 50_000,
    "coinsurance_pct": "10",
    "oop_max_cents": 300_000,
    "employer_hsa_cents": 0,
}
B_TWIN = {**B, "name": "Gold PPO 2"}
C = {
    "name": "Silver HMO",
    "kind": "hmo",
    "premium_per_period_cents": 4_000,
    "deductible_cents": 100_000,
    "coinsurance_pct": "0",
    "oop_max_cents": 250_000,
    "employer_hsa_cents": 0,
}
BRACKETS_ONLY = ["health.federal_brackets"]


def payload(
    plans: list[dict[str, Any]], salary: int, employee_hsa: int, **extra: Any
) -> dict[str, Any]:
    return {
        "plans": plans,
        "pay_periods_per_year": 26,
        "salary_cents": salary,
        "filing_status": "single",
        "tax_year": 2026,
        "employee_hsa_cents": employee_hsa,
        "expected_usage": "medium",
        **extra,
    }


def run(plans: list[dict[str, Any]], salary: int, employee_hsa: int, **extra: Any) -> Any:
    return health_plans(
        HealthPlansInput.model_validate(payload(plans, salary, employee_hsa, **extra))
    )


def costs(result: HealthPlansResult, index: int) -> tuple[int, int, int, int]:
    plan = result.plans[index]
    return (
        plan.low_cost_cents,
        plan.medium_cost_cents,
        plan.high_cost_cents,
        plan.worst_case_cents,
    )


def hsa(result: HealthPlansResult, index: int) -> tuple[bool, int, bool, int]:
    plan = result.plans[index]
    return (
        plan.hsa_eligible,
        plan.employee_hsa_cents,
        plan.hsa_capped,
        plan.hsa_tax_savings_cents,
    )


def pairs(result: HealthPlansResult) -> list[tuple[int, int, int | None, list[int], int | None]]:
    return [
        (
            pair.plan_a_index,
            pair.plan_b_index,
            pair.cheaper_at_zero_index,
            pair.break_even_spends_cents,
            pair.cheaper_at_end_index,
        )
        for pair in result.pairs
    ]


B_COSTS = (212_500, 237_500, 307_500, 462_500)
NO_HSA = (False, 0, False, 0)


def test_hdhp_versus_ppo() -> None:
    result = run([A, B], 6_500_000, 100_000)
    assert result.marginal_rate_used == Decimal("12.00")
    assert (result.hsa_limit_cents, result.hdhp_min_deductible_cents) == (440_000, 170_000)
    assert result.hdhp_max_oop_cents == 850_000
    assert [plan.annual_premium_cents for plan in result.plans] == [65_000, 162_500]
    assert [plan.employer_hsa_cents for plan in result.plans] == [75_000, 0]
    assert hsa(result, 0) == (True, 100_000, False, 12_000)
    assert hsa(result, 1) == NO_HSA
    assert costs(result, 0) == (28_000, 174_000, 314_000, 378_000)
    assert costs(result, 1) == B_COSTS
    assert pairs(result) == [(0, 1, 0, [940_000, 1_710_000], 0)]
    assert result.recommended_index == 0
    assert result.selected_index is None
    assert (result.scan_step_cents, result.scan_end_cents) == (SCAN_STEP_CENTS, 2_550_000)
    assert result.citation_keys == list(HDHP_CITATION_KEYS)


def test_three_plans_pairwise() -> None:
    result = run([A, B, C], 6_500_000, 100_000)
    assert costs(result, 0) == (28_000, 174_000, 314_000, 378_000)
    assert costs(result, 1) == B_COSTS
    assert costs(result, 2) == (154_000, 204_000, 204_000, 354_000)
    assert hsa(result, 2) == NO_HSA
    assert pairs(result) == [
        (0, 1, 0, [940_000, 1_710_000], 0),
        (0, 2, 0, [450_000, 460_000], 2),
        (1, 2, 2, [], 2),
    ]
    assert result.recommended_index == 0
    assert result.scan_end_cents == 2_550_000


def test_hsa_contribution_capped_at_limit() -> None:
    result = run([A, B], 9_000_000, 500_000)
    assert result.marginal_rate_used == Decimal("22.00")
    assert hsa(result, 0) == (True, 365_000, True, 80_300)
    assert costs(result, 0) == (-40_300, 105_700, 245_700, 309_700)
    assert costs(result, 1) == B_COSTS
    assert pairs(result) == [(0, 1, 0, [], 0)]
    assert result.recommended_index == 0


def test_hdhp_below_minimum_deductible() -> None:
    result = run([A_LOW_DEDUCTIBLE, B], 6_500_000, 100_000)
    assert hsa(result, 0) == NO_HSA
    assert result.plans[0].employer_hsa_cents == 75_000
    assert costs(result, 0) == (40_000, 170_000, 310_000, 390_000)
    assert pairs(result) == [(0, 1, 0, [980_000, 1_830_000], 0)]
    assert result.recommended_index == 0
    assert result.citation_keys == list(HDHP_CITATION_KEYS)


def test_ten_percent_bracket_rounds_half_up() -> None:
    result = run([A], 2_500_000, 12_345)
    assert result.marginal_rate_used == Decimal("10.00")
    assert hsa(result, 0) == (True, 12_345, False, 1_235)
    assert costs(result, 0) == (38_766, 184_766, 324_766, 388_766)
    assert result.pairs == []
    assert result.recommended_index == 0
    assert result.scan_end_cents == 1_320_000


def test_zero_marginal_rate() -> None:
    result = run([A, B], 1_500_000, 100_000)
    assert result.marginal_rate_used == Decimal("0.00")
    assert hsa(result, 0) == (True, 100_000, False, 0)
    assert costs(result, 0) == (40_000, 186_000, 326_000, 390_000)
    assert pairs(result) == [(0, 1, 0, [820_000, 1_830_000], 0)]


def test_identical_plans_tie() -> None:
    result = run([B, B_TWIN], 6_500_000, 100_000)
    assert costs(result, 0) == costs(result, 1) == B_COSTS
    assert hsa(result, 0) == hsa(result, 1) == NO_HSA
    assert pairs(result) == [(0, 1, None, [], None)]
    assert result.recommended_index == 0
    assert result.citation_keys == BRACKETS_ONLY


def test_high_usage_recommends_ppo() -> None:
    result = run([A, B], 6_500_000, 100_000, expected_usage="high")
    assert pairs(result) == [(0, 1, 0, [940_000, 1_710_000], 0)]
    assert result.recommended_index == 1


# ---------------------------------------------------------------- edge cases


def test_selected_plan_is_echoed() -> None:
    assert run([A, B], 6_500_000, 0, selected_plan_index=1).selected_index == 1


def test_full_coinsurance_caps_at_the_maximum() -> None:
    plan = {**B, "coinsurance_pct": "100", "employer_hsa_cents": 0}
    assert run([plan], 6_500_000, 0).scan_end_cents == 300_000


def test_tiny_coinsurance_stops_the_scan_at_a_million_dollars() -> None:
    plan = {**B, "coinsurance_pct": "0.01", "oop_max_cents": 5_000_000}
    assert run([plan, B], 6_500_000, 0).scan_end_cents == 100_000_000


def test_employer_hsa_above_the_limit_leaves_no_room() -> None:
    plan = {**A, "employer_hsa_cents": 500_000}
    result = run([plan], 6_500_000, 100_000)
    assert hsa(result, 0) == (True, 0, True, 0)
    assert result.plans[0].employer_hsa_cents == 500_000


@pytest.mark.parametrize(
    "change",
    [
        {"plans": []},
        {"plans": [B] * 9},
        {"plans": [{**B, "employer_hsa_cents": 100}]},
        {"plans": [{**B, "deductible_cents": 400_000}]},
        {"selected_plan_index": 2},
        {"selected_plan_index": -1},
        {"usage_low_cents": 300_000},
        {"usage_high_cents": 300_000},
        {"tax_year": 2027},
        {"salary_cents": 0},
        {"employee_hsa_cents": -1},
    ],
)
def test_invalid_inputs_are_refused(change: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        HealthPlansInput.model_validate({**payload([A, B], 6_500_000, 0), **change})


def test_default_scenarios() -> None:
    data = HealthPlansInput.model_validate(payload([A], 6_500_000, 0))
    assert (data.usage_low_cents, data.usage_medium_cents, data.usage_high_cents) == (
        50_000,
        300_000,
        1_000_000,
    )
    assert data.enrollment_deadline is None
