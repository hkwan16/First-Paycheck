"""Spec 006 properties, checked with Hypothesis over generated inputs."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from hypothesis import assume, given, settings
from hypothesis import strategies as st

from calc.data import tax_year
from calc.k401 import K401MatchInput, K401MatchResult, k401_match

# Examples per property; tests/support/hypothesis_profiles.py sets the rest.
EXAMPLES = settings(max_examples=300)

MONEY_FIELDS = (
    "employer_match_cents_current",
    "employer_match_cents_full",
    "missed_cents",
    "employee_annual_cents_current",
    "employee_annual_cents_full",
    "per_paycheck_cost_delta_cents",
    "per_paycheck_after_tax_cost_cents",
    "deferral_limit_cents",
)
LIMITS = tax_year(2026).k401


def percents(low: int, high: int) -> st.SearchStrategy[Decimal]:
    """Two-place percentages from ``low`` to ``high`` hundredths."""
    return st.integers(low, high).map(lambda hundredths: Decimal(hundredths) / 100)


@st.composite
def tiers(draw: st.DrawFn) -> list[dict[str, Decimal]]:
    bounds = sorted(draw(st.sets(st.integers(1, 2_000), min_size=0, max_size=4)))
    return [
        {"employee_pct_upto": Decimal(bound) / 100, "employer_pct": draw(percents(1, 10_000))}
        for bound in bounds
    ]


@st.composite
def inputs(draw: st.DrawFn) -> K401MatchInput:
    return K401MatchInput.model_validate(
        {
            "salary_cents": draw(st.integers(100_000, 100_000_000)),
            "pay_periods_per_year": draw(st.sampled_from([12, 24, 26, 52])),
            "match_tiers": draw(tiers()),
            "contribution_pct": draw(percents(0, 10_000)),
            "tax_year": 2026,
            "filing_status": draw(
                st.sampled_from(["single", "married_filing_jointly", "head_of_household"])
            ),
            "age": draw(st.integers(18, 80)),
        }
    )


def with_contribution(data: K401MatchInput, pct: Decimal) -> K401MatchInput:
    return data.model_copy(update={"contribution_pct": pct})


@EXAMPLES
@given(inputs())
def test_every_money_output_is_an_int(data: K401MatchInput) -> None:
    result = k401_match(data)
    for name in MONEY_FIELDS:
        assert type(getattr(result, name)) is int, name
    dumped: dict[str, Any] = result.model_dump(mode="json")
    for name in MONEY_FIELDS:
        assert type(dumped[name]) is int, name


@EXAMPLES
@given(inputs())
def test_match_is_bounded(data: K401MatchInput) -> None:
    result = k401_match(data)
    assert 0 <= result.employer_match_cents_current <= result.employer_match_cents_full
    assert result.missed_cents >= 0


@EXAMPLES
@given(inputs(), percents(0, 10_000))
def test_match_is_non_decreasing_in_contribution(data: K401MatchInput, other: Decimal) -> None:
    low, high = sorted((data.contribution_pct, other))
    lower = k401_match(with_contribution(data, low))
    higher = k401_match(with_contribution(data, high))
    assert lower.employer_match_cents_current <= higher.employer_match_cents_current


@EXAMPLES
@given(inputs())
def test_nothing_missed_at_or_above_full_match(data: K401MatchInput) -> None:
    result = k401_match(data)
    if data.contribution_pct >= result.full_match_pct:
        assert result.missed_cents == 0


@EXAMPLES
@given(inputs())
def test_something_missed_below_full_match_when_no_limit_binds(data: K401MatchInput) -> None:
    result = k401_match(data)
    salary = Decimal(data.salary_cents)
    full = result.full_match_pct
    assume(data.match_tiers)
    assume(data.contribution_pct < full)
    assume(salary * full / 100 <= result.deferral_limit_cents)
    assume(data.salary_cents <= LIMITS.compensation_limit_cents)
    smallest_rate = min(tier.employer_pct for tier in data.match_tiers)
    # The exact difference is at least this much; at one cent or more it
    # survives rounding to whole cents.
    assume(smallest_rate / 100 * salary * (full - data.contribution_pct) / 100 >= 1)
    assert result.missed_cents > 0


@EXAMPLES
@given(inputs())
def test_after_tax_cost_is_between_zero_and_the_pre_tax_cost(data: K401MatchInput) -> None:
    result = k401_match(data)
    assert 0 <= result.per_paycheck_after_tax_cost_cents <= result.per_paycheck_cost_delta_cents


@EXAMPLES
@given(inputs())
def test_deferral_never_exceeds_the_limit(data: K401MatchInput) -> None:
    result = k401_match(data)
    assert result.employee_annual_cents_current <= result.deferral_limit_cents
    assert result.employee_annual_cents_full <= result.deferral_limit_cents


@EXAMPLES
@given(inputs())
def test_capped_flags_agree_with_the_limits(data: K401MatchInput) -> None:
    result = k401_match(data)
    requested = Decimal(data.salary_cents) * data.contribution_pct / 100
    assert result.capped == (requested > result.deferral_limit_cents)
    assert result.compensation_capped == (data.salary_cents > LIMITS.compensation_limit_cents)


@EXAMPLES
@given(inputs())
def test_pure(data: K401MatchInput) -> None:
    first: K401MatchResult = k401_match(data)
    second = k401_match(K401MatchInput.model_validate(data.model_dump()))
    assert first == second
    assert first.model_dump() == second.model_dump()
