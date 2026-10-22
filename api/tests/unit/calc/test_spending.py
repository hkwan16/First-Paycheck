"""calc/spending.py: bucket totals, left over and shares of income (spec 007 part B)."""

from __future__ import annotations

from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st
from pydantic import ValidationError

from calc.spending import Bucket, CategorySum, summarize

BUCKETS: dict[str, Bucket] = {
    "income": "income",
    "housing": "essentials",
    "groceries": "essentials",
    "dining": "flexible",
    "savings_investment": "savings",
    "fees": "other",
    "transfer": "transfer",
}


def out(category: str | None, cents: int, count: int = 1) -> CategorySum:
    """``count`` transactions of money out summing to ``cents``."""
    return CategorySum(category=category, out_cents=cents, in_cents=0, count=count, out_count=count)


def into(category: str | None, cents: int, count: int = 1) -> CategorySum:
    """``count`` transactions of money in whose magnitudes sum to ``cents``."""
    return CategorySum(category=category, out_cents=0, in_cents=cents, count=count, out_count=0)


def test_the_spec_month() -> None:
    sums = [
        into("income", 399_208, count=2),
        out("housing", 150_000),
        CategorySum(category="groceries", out_cents=32_000, in_cents=2_000, count=2, out_count=1),
        out("dining", 8_500),
        out("savings_investment", 40_000),
        out("transfer", 25_000),
        out("fees", 3_900),
        out(None, 1_200),
    ]
    totals = summarize(sums, BUCKETS)
    assert totals.income_cents == 399_208
    assert totals.essentials_cents == 180_000
    assert totals.flexible_cents == 8_500
    assert totals.savings_cents == 40_000
    assert totals.other_cents == 3_900
    assert totals.transfers_ignored_cents == 25_000
    assert totals.income_outflows_ignored_cents == 0
    assert totals.uncategorized_cents == 1_200
    assert totals.uncategorized_count == 1
    assert totals.left_over_cents == 166_808
    assert totals.essentials_pct == Decimal("45.1")
    assert totals.flexible_pct == Decimal("2.1")
    assert totals.savings_rate_pct == Decimal("10.0")
    assert totals.transaction_count == 10
    assert [(c.category, c.bucket, c.total_cents, c.count) for c in totals.categories] == [
        ("income", "income", 399_208, 2),
        ("housing", "essentials", 150_000, 1),
        ("groceries", "essentials", 30_000, 2),
        ("dining", "flexible", 8_500, 1),
        ("savings_investment", "savings", 40_000, 1),
        ("transfer", "transfer", 25_000, 1),
        ("fees", "other", 3_900, 1),
    ]


def test_an_income_labeled_outflow_is_not_income() -> None:
    # Spec 007 rule 22a, "Income-labeled money out": a paycheck -200,000 and
    # interest -422 came in; the payroll a bank booked as money out, 585,000,
    # is labeled income too.
    sums = [
        CategorySum(category="income", out_cents=585_000, in_cents=200_422, count=3, out_count=1),
        out("housing", 50_000),
        out("dining", 1_633),
    ]
    totals = summarize(sums, BUCKETS)
    assert totals.income_cents == 200_422
    assert totals.income_outflows_ignored_cents == 585_000
    assert totals.transfers_ignored_cents == 0
    assert totals.essentials_cents == 50_000
    assert totals.flexible_cents == 1_633
    assert totals.savings_cents == totals.other_cents == 0
    assert totals.left_over_cents == 148_789
    assert totals.essentials_pct == Decimal("24.9")
    assert totals.flexible_pct == Decimal("0.8")
    assert totals.savings_rate_pct == Decimal("0.0")
    assert totals.transaction_count == 5
    assert [(c.category, c.bucket, c.total_cents, c.count) for c in totals.categories] == [
        ("income", "income", 200_422, 2),
        ("housing", "essentials", 50_000, 1),
        ("dining", "flexible", 1_633, 1),
    ]


def test_an_income_outflow_alone_leaves_income_at_zero() -> None:
    totals = summarize([out("income", 585_000)], BUCKETS)
    assert totals.income_cents == 0
    assert totals.income_outflows_ignored_cents == 585_000
    assert totals.left_over_cents == 0
    assert (totals.essentials_pct, totals.flexible_pct, totals.savings_rate_pct) == (
        None,
        None,
        None,
    )
    assert totals.transaction_count == 1
    assert totals.categories == []


def test_a_zero_income_row_counts_as_income() -> None:
    zero = CategorySum(category="income", out_cents=0, in_cents=0, count=1, out_count=0)
    totals = summarize([zero], BUCKETS)
    assert totals.income_cents == 0
    assert [(c.category, c.total_cents, c.count) for c in totals.categories] == [("income", 0, 1)]


def test_no_income_gives_no_percentages() -> None:
    totals = summarize([out("dining", 1_000)], BUCKETS)
    assert totals.income_cents == 0
    assert totals.left_over_cents == -1_000
    assert totals.essentials_pct is None
    assert totals.flexible_pct is None
    assert totals.savings_rate_pct is None


def test_empty_period_is_all_zero() -> None:
    totals = summarize([], BUCKETS)
    assert totals.transaction_count == 0
    assert totals.left_over_cents == 0
    assert totals.income_outflows_ignored_cents == 0
    assert totals.categories == []


def test_percent_rounds_half_up_to_one_place() -> None:
    sums = [
        into("income", 200_000),
        out("dining", 2_500),
        into("housing", 100),
        out("savings_investment", 2_450),
    ]
    totals = summarize(sums, BUCKETS)
    assert totals.flexible_pct == Decimal("1.3")  # 1.25 is a tie: half up
    assert totals.savings_rate_pct == Decimal("1.2")  # 1.225
    # A refund-only bucket is negative spending; -0.05 rounds away from zero.
    assert totals.essentials_cents == -100
    assert totals.essentials_pct == Decimal("-0.1")


@pytest.mark.parametrize(
    "fields",
    [
        {"out_cents": -1, "in_cents": 0, "count": 1, "out_count": 1},
        {"out_cents": 0, "in_cents": -1, "count": 1, "out_count": 0},
        {"out_cents": 5, "in_cents": 0, "count": 1, "out_count": 2},
        {"out_cents": 5, "in_cents": 0, "count": 1, "out_count": -1},
    ],
)
def test_category_sums_are_magnitudes(fields: dict[str, int]) -> None:
    with pytest.raises(ValidationError):
        CategorySum(category="dining", **fields)


money = st.integers(min_value=0, max_value=10**10)


@st.composite
def category_sums(draw: st.DrawFn) -> list[CategorySum]:
    sums: list[CategorySum] = []
    for category in draw(st.lists(st.sampled_from([*BUCKETS, None]), unique=True)):
        count = draw(st.integers(min_value=1, max_value=50))
        out_count = draw(st.integers(min_value=0, max_value=count))
        sums.append(
            CategorySum(
                category=category,
                out_cents=draw(money) if out_count else 0,
                in_cents=draw(money) if out_count < count else 0,
                count=count,
                out_count=out_count,
            )
        )
    return sums


@given(category_sums())
def test_income_is_money_in_and_never_negative(sums: list[CategorySum]) -> None:
    totals = summarize(sums, BUCKETS)
    income = [item for item in sums if item.category == "income"]
    assert totals.income_cents >= 0
    assert totals.income_cents == sum(item.in_cents for item in income)
    assert totals.income_outflows_ignored_cents == sum(item.out_cents for item in income)
    spent = totals.essentials_cents + totals.flexible_cents + totals.other_cents
    assert totals.left_over_cents == totals.income_cents - spent - totals.savings_cents
    assert totals.transaction_count == sum(item.count for item in sums)
    if totals.income_cents == 0:
        assert totals.essentials_pct is totals.flexible_pct is totals.savings_rate_pct is None
