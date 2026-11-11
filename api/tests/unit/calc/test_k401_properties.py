"""Spec 006 properties, checked with Hypothesis over generated inputs."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from hypothesis import assume, given, settings
from hypothesis import strategies as st

from calc.data import tax_year
from calc.k401 import K401MatchInput, K401MatchResult, k401_match, rate_change

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


@st.composite
def below_full_match_inputs(draw: st.DrawFn) -> K401MatchInput:
    """Inputs under the full match with no limit binding, built rather than filtered.

    Drawing ``inputs()`` and rejecting the rest kept about one in twenty (a
    contribution under the highest tier is rare in 0-100%, and so is a salary
    under both limits), and Hypothesis's filter_too_much health check failed
    the test on unlucky runs.
    """
    data = draw(inputs().filter(lambda d: bool(d.match_tiers)))
    full = max(tier.employee_pct_upto for tier in data.match_tiers)
    # The base deferral limit, the smallest at any age, so no age makes it bind.
    salary_cap = min(
        LIMITS.compensation_limit_cents,
        int(Decimal(LIMITS.elective_deferral_limit_cents) * 100 / full),
    )
    hundredths = int(full * 100)
    return data.model_copy(
        update={
            "salary_cents": draw(st.integers(100_000, max(100_000, salary_cap))),
            "contribution_pct": Decimal(draw(st.integers(0, hundredths - 1))) / 100,
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
@given(below_full_match_inputs())
def test_something_missed_below_full_match_when_no_limit_binds(data: K401MatchInput) -> None:
    result = k401_match(data)
    salary = Decimal(data.salary_cents)
    full = result.full_match_pct
    # What the strategy builds: below the full match, and no limit binds.
    assert data.contribution_pct < full
    assert salary * full / 100 <= result.deferral_limit_cents
    assert data.salary_cents <= LIMITS.compensation_limit_cents
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


# ---------------------------------------------------------------- rule 15 (issue 223)


@EXAMPLES
@given(inputs())
def test_rate_change_from_the_chosen_rate_is_zero(data: K401MatchInput) -> None:
    moved = rate_change(data, data.contribution_pct)
    assert (moved.per_paycheck_cents, moved.per_paycheck_after_tax_cents) == (0, 0)


@EXAMPLES
@given(inputs(), percents(0, 10_000), percents(0, 10_000))
def test_rate_change_rises_with_the_chosen_rate(
    data: K401MatchInput, other: Decimal, start: Decimal
) -> None:
    low, high = sorted((data.contribution_pct, other))
    lower = rate_change(with_contribution(data, low), start)
    higher = rate_change(with_contribution(data, high), start)
    assert lower.per_paycheck_cents <= higher.per_paycheck_cents


@EXAMPLES
@given(inputs(), percents(0, 10_000))
def test_rate_change_figures_agree_in_sign_and_size(data: K401MatchInput, start: Decimal) -> None:
    moved = rate_change(data, start)
    before, after = moved.per_paycheck_cents, moved.per_paycheck_after_tax_cents
    assert type(before) is int
    assert type(after) is int
    assert before * after >= 0
    assert abs(after) <= abs(before)


@EXAMPLES
@given(inputs())
def test_rate_change_from_the_full_match_undoes_the_cost_of_reaching_it(
    data: K401MatchInput,
) -> None:
    result = k401_match(data)
    assume(data.contribution_pct < result.full_match_pct)
    moved = rate_change(data, result.full_match_pct)
    assert moved.per_paycheck_cents == -result.per_paycheck_cost_delta_cents
    assert moved.per_paycheck_after_tax_cents == -result.per_paycheck_after_tax_cost_cents
