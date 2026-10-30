"""Spec 014 properties, checked with Hypothesis over generated inputs."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from hypothesis import assume, given, settings
from hypothesis import strategies as st

from calc.w4 import W4Input, w4

# Examples per property; tests/support/hypothesis_profiles.py sets the rest.
EXAMPLES = settings(max_examples=150)

SIGNED = {"projected_refund_cents", "suggested_refund_cents", "current_refund_cents"}
# Rule 10a: null exactly when there is no current withholding to compare with.
COMPARISON = {"current_annual_withholding_cents", "current_refund_cents"}


@st.composite
def entries(draw: st.DrawFn) -> dict[str, Any]:
    """Everything but the salary, so a property can vary the salary alone."""
    return {
        "pay_periods_per_year": draw(st.sampled_from([12, 24, 26, 52])),
        "filing_status": draw(
            st.sampled_from(["single", "married_filing_jointly", "head_of_household"])
        ),
        "tax_year": 2026,
        "k401_contribution_pct": Decimal(draw(st.integers(0, 2_000))) / 100,
        "age": draw(st.none() | st.integers(18, 70)),
        "health_premium_per_paycheck_cents": draw(st.integers(0, 20_000)),
        "multiple_jobs": draw(st.booleans()),
        "dependents_credit_cents": draw(st.sampled_from([0, 50_000, 220_000, 440_000])),
        "other_income_cents": draw(st.integers(0, 2_000_000)),
        "deductions_cents": draw(st.integers(0, 3_000_000)),
        "extra_withholding_cents": draw(st.integers(0, 50_000)),
        "expected_deductions_cents": draw(st.none() | st.integers(0, 3_000_000)),
        "other_jobs_wages_cents": draw(st.integers(0, 10_000_000)),
        "other_jobs_withholding_cents": draw(st.integers(0, 1_500_000)),
        "current_withholding_per_paycheck_cents": draw(st.none() | st.integers(0, 500_000)),
    }


def build(salary: int, rest: dict[str, Any]) -> W4Input:
    deferral = Decimal(salary) * rest["k401_contribution_pct"] / 100
    premiums = rest["health_premium_per_paycheck_cents"] * rest["pay_periods_per_year"]
    assume(deferral + premiums <= salary)
    return W4Input.model_validate({"salary_cents": salary, **rest})


SALARY = st.integers(1_000_000, 60_000_000)


@EXAMPLES
@given(SALARY, entries())
def test_money_outputs_are_ints_and_non_negative(salary: int, rest: dict[str, Any]) -> None:
    result = w4(build(salary, rest)).model_dump()
    for key, value in result.items():
        if key.endswith("_cents"):
            if key in COMPARISON and rest["current_withholding_per_paycheck_cents"] is None:
                assert value is None, key
                continue
            assert type(value) is int, key
            if key not in SIGNED:
                assert value >= 0, key


@EXAMPLES
@given(SALARY, SALARY, entries())
def test_withholding_is_monotone_in_salary(low: int, high: int, rest: dict[str, Any]) -> None:
    low, high = sorted((low, high))
    first = w4(build(low, rest))
    second = w4(build(high, rest))
    assert first.withholding_per_paycheck_cents <= second.withholding_per_paycheck_cents


@EXAMPLES
@given(SALARY, entries())
def test_outputs_add_up(salary: int, rest: dict[str, Any]) -> None:
    data = build(salary, rest)
    result = w4(data)
    assert (
        result.annual_withholding_cents
        == result.withholding_per_paycheck_cents * data.pay_periods_per_year
    )
    assert result.projected_refund_cents == (
        result.annual_withholding_cents
        + data.other_jobs_withholding_cents
        - result.projected_tax_after_credits_cents
    )
    assert result.projected_tax_after_credits_cents <= result.projected_tax_cents


@EXAMPLES
@given(SALARY, entries())
def test_the_comparison_adds_up(salary: int, rest: dict[str, Any]) -> None:
    """Rule 10a: the same tax, so the two refunds differ only by withholding."""
    data = build(salary, rest)
    result = w4(data)
    current = data.current_withholding_per_paycheck_cents
    if current is None:
        assert result.current_annual_withholding_cents is None
        assert result.current_refund_cents is None
        return
    periods = data.pay_periods_per_year
    assert result.current_annual_withholding_cents == current * periods
    assert result.current_refund_cents == (
        current * periods
        + data.other_jobs_withholding_cents
        - result.projected_tax_after_credits_cents
    )
    assert (
        result.projected_refund_cents - result.current_refund_cents
        == (result.withholding_per_paycheck_cents - current) * periods
    )


@EXAMPLES
@given(SALARY, entries())
def test_the_comparison_changes_nothing_else(salary: int, rest: dict[str, Any]) -> None:
    data = build(salary, rest)
    without = w4(data.model_copy(update={"current_withholding_per_paycheck_cents": None}))
    assert w4(data).model_dump(exclude=COMPARISON) == without.model_dump(exclude=COMPARISON)


@EXAMPLES
@given(SALARY, entries())
def test_suggestions_land_within_100_dollars(salary: int, rest: dict[str, Any]) -> None:
    result = w4(build(salary, rest))
    if result.suggestion == "increase_extra_withholding":
        assert abs(result.suggested_refund_cents) <= 10_000
    if result.suggestion == "decrease_extra_withholding":
        # Within $100, or Step 4(c) is gone and the refund left is not this form's.
        assert abs(result.suggested_refund_cents) <= 10_000 or (
            result.suggested_extra_withholding_cents == 0 and result.suggested_refund_cents > 0
        )
    if result.suggestion == "none":
        assert result.suggested_refund_cents == result.projected_refund_cents
    if abs(result.projected_refund_cents) <= 10_000:
        assert result.suggestion == "none"


@EXAMPLES
@given(SALARY, entries())
def test_suggested_entries_reproduce_the_suggested_refund(
    salary: int, rest: dict[str, Any]
) -> None:
    """Entering the suggestion (keeping the expected deductions) projects what it said."""
    data = build(salary, rest)
    result = w4(data)
    expected = (
        data.expected_deductions_cents
        if data.expected_deductions_cents is not None
        else data.deductions_cents
    )
    again = w4(
        data.model_copy(
            update={
                "extra_withholding_cents": result.suggested_extra_withholding_cents,
                "deductions_cents": result.suggested_deductions_cents,
                "expected_deductions_cents": expected,
            }
        )
    )
    assert again.projected_refund_cents == result.suggested_refund_cents


@EXAMPLES
@given(SALARY, entries())
def test_pure(salary: int, rest: dict[str, Any]) -> None:
    data = build(salary, rest)
    assert w4(data) == w4(data)
