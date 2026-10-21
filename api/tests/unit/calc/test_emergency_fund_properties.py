"""Spec 011 properties, checked with Hypothesis over generated inputs."""

from __future__ import annotations

import os
from decimal import Decimal

from hypothesis import given, settings
from hypothesis import strategies as st

from calc.emergency_fund import EmergencyFundInput, emergency_fund

settings.register_profile("ci", derandomize=True, max_examples=300)
settings.register_profile("dev", max_examples=200)
settings.load_profile("ci" if os.environ.get("CI") else "dev")

MONEY = (
    "target_cents",
    "three_month_target_cents",
    "six_month_target_cents",
    "shortfall_cents",
    "per_paycheck_contribution_cents",
)


@st.composite
def inputs(draw: st.DrawFn) -> EmergencyFundInput:
    return EmergencyFundInput.model_validate(
        {
            "monthly_essentials_cents": draw(st.integers(1, 5_000_000)),
            "target_months": draw(st.integers(1, 12)),
            "current_balance_cents": draw(st.integers(0, 50_000_000)),
            "monthly_contribution_cents": draw(st.integers(0, 1_000_000)),
            "pay_periods_per_year": draw(st.sampled_from([12, 24, 26, 52])),
        }
    )


@given(inputs())
def test_money_outputs_are_ints_and_the_range_is_ordered(data: EmergencyFundInput) -> None:
    result = emergency_fund(data)
    for name in MONEY:
        assert type(getattr(result, name)) is int, name
    assert result.three_month_target_cents <= result.six_month_target_cents


@given(inputs())
def test_funded_exactly_when_nothing_is_short(data: EmergencyFundInput) -> None:
    result = emergency_fund(data)
    assert (result.shortfall_cents == 0) == result.funded
    if result.funded:
        assert result.months_to_target == 0
        assert result.funded_pct == Decimal(100)
        assert result.reachable


@given(inputs())
def test_months_are_the_fewest_that_close_the_gap(data: EmergencyFundInput) -> None:
    result = emergency_fund(data)
    months = result.months_to_target
    if months:
        contribution = data.monthly_contribution_cents
        assert months * contribution >= result.shortfall_cents
        assert (months - 1) * contribution < result.shortfall_cents
        assert months <= result.horizon_months
    assert result.reachable == (months is not None)


@given(inputs(), st.integers(0, 1_000_000))
def test_more_contribution_never_takes_longer(data: EmergencyFundInput, other: int) -> None:
    low, high = sorted((data.monthly_contribution_cents, other))
    slower = emergency_fund(data.model_copy(update={"monthly_contribution_cents": low}))
    faster = emergency_fund(data.model_copy(update={"monthly_contribution_cents": high}))
    if slower.months_to_target is not None:
        assert faster.months_to_target is not None
        assert faster.months_to_target <= slower.months_to_target


@given(inputs())
def test_funded_pct_is_a_percentage(data: EmergencyFundInput) -> None:
    assert Decimal(0) <= emergency_fund(data).funded_pct <= Decimal(100)
