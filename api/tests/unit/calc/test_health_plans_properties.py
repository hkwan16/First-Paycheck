"""Spec 012 properties, checked with Hypothesis over generated inputs."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from hypothesis import given, settings
from hypothesis import strategies as st

from calc.health_plans import SCAN_STEP_CENTS, HealthPlansInput, health_plans

# Examples per property; tests/support/hypothesis_profiles.py sets the rest.
EXAMPLES = settings(max_examples=150)

MONEY = (
    "annual_premium_cents",
    "employer_hsa_cents",
    "employee_hsa_cents",
    "hsa_tax_savings_cents",
    "low_cost_cents",
    "medium_cost_cents",
    "high_cost_cents",
    "worst_case_cents",
)


@st.composite
def plan(draw: st.DrawFn) -> dict[str, Any]:
    kind = draw(st.sampled_from(["hdhp", "ppo", "hmo"]))
    deductible = draw(st.integers(0, 800_000))
    oop_max = deductible + draw(st.integers(0, 900_000))
    return {
        "name": "Plan",
        "kind": kind,
        "premium_per_period_cents": draw(st.integers(0, 50_000)),
        "deductible_cents": deductible,
        "coinsurance_pct": Decimal(draw(st.integers(0, 10_000))) / 100,
        "oop_max_cents": oop_max,
        "employer_hsa_cents": draw(st.integers(0, 600_000)) if kind == "hdhp" else 0,
    }


@st.composite
def inputs(draw: st.DrawFn) -> HealthPlansInput:
    return HealthPlansInput.model_validate(
        {
            "plans": draw(st.lists(plan(), min_size=1, max_size=4)),
            "pay_periods_per_year": draw(st.sampled_from([12, 24, 26, 52])),
            "salary_cents": draw(st.integers(100_000, 50_000_000)),
            "filing_status": draw(
                st.sampled_from(["single", "married_filing_jointly", "head_of_household"])
            ),
            "tax_year": 2026,
            "employee_hsa_cents": draw(st.integers(0, 600_000)),
            "expected_usage": draw(st.sampled_from(["low", "medium", "high"])),
        }
    )


@EXAMPLES
@given(inputs())
def test_money_is_int_and_costs_rise_with_usage(data: HealthPlansInput) -> None:
    result = health_plans(data)
    for plan_cost in result.plans:
        for name in MONEY:
            assert type(getattr(plan_cost, name)) is int, name
        assert (
            plan_cost.low_cost_cents
            <= plan_cost.medium_cost_cents
            <= plan_cost.high_cost_cents
            <= plan_cost.worst_case_cents
        )


@EXAMPLES
@given(inputs())
def test_hsa_amounts_stay_within_the_limit(data: HealthPlansInput) -> None:
    result = health_plans(data)
    for plan_cost in result.plans:
        assert plan_cost.hsa_tax_savings_cents <= plan_cost.employee_hsa_cents
        if plan_cost.hsa_eligible and plan_cost.employee_hsa_cents:
            total = plan_cost.employee_hsa_cents + plan_cost.employer_hsa_cents
            assert total <= result.hsa_limit_cents
        if not plan_cost.hsa_eligible:
            assert plan_cost.employee_hsa_cents == 0


@EXAMPLES
@given(inputs())
def test_break_evens_are_scanned_points_in_order(data: HealthPlansInput) -> None:
    result = health_plans(data)
    count = len(data.plans)
    assert len(result.pairs) == count * (count - 1) // 2
    for pair in result.pairs:
        spends = pair.break_even_spends_cents
        assert spends == sorted(set(spends))
        for spend in spends:
            assert 0 < spend <= result.scan_end_cents
            assert spend % SCAN_STEP_CENTS == 0
        if not spends:
            assert pair.cheaper_at_zero_index == pair.cheaper_at_end_index
    if count == 1:
        assert result.pairs == []
        assert result.recommended_index == 0
