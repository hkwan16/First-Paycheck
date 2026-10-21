"""calc/spending.py: bucket totals, left over and shares of income (spec 007 part B)."""

from __future__ import annotations

from decimal import Decimal

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


def test_the_spec_month() -> None:
    sums = [
        CategorySum(category="income", net_cents=-399_208, abs_cents=399_208, count=2),
        CategorySum(category="housing", net_cents=150_000, abs_cents=150_000, count=1),
        CategorySum(category="groceries", net_cents=30_000, abs_cents=34_000, count=2),
        CategorySum(category="dining", net_cents=8_500, abs_cents=8_500, count=1),
        CategorySum(category="savings_investment", net_cents=40_000, abs_cents=40_000, count=1),
        CategorySum(category="transfer", net_cents=25_000, abs_cents=25_000, count=1),
        CategorySum(category="fees", net_cents=3_900, abs_cents=3_900, count=1),
        CategorySum(category=None, net_cents=1_200, abs_cents=1_200, count=1),
    ]
    totals = summarize(sums, BUCKETS)
    assert totals.income_cents == 399_208
    assert totals.essentials_cents == 180_000
    assert totals.flexible_cents == 8_500
    assert totals.savings_cents == 40_000
    assert totals.other_cents == 3_900
    assert totals.transfers_ignored_cents == 25_000
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


def test_no_income_gives_no_percentages() -> None:
    totals = summarize(
        [CategorySum(category="dining", net_cents=1_000, abs_cents=1_000, count=1)], BUCKETS
    )
    assert totals.income_cents == 0
    assert totals.left_over_cents == -1_000
    assert totals.essentials_pct is None
    assert totals.flexible_pct is None
    assert totals.savings_rate_pct is None


def test_empty_period_is_all_zero() -> None:
    totals = summarize([], BUCKETS)
    assert totals.transaction_count == 0
    assert totals.left_over_cents == 0
    assert totals.categories == []


def test_percent_rounds_half_up_to_one_place() -> None:
    sums = [
        CategorySum(category="income", net_cents=-200_000, abs_cents=200_000, count=1),
        CategorySum(category="dining", net_cents=2_500, abs_cents=2_500, count=1),
        CategorySum(category="housing", net_cents=-100, abs_cents=100, count=1),
        CategorySum(category="savings_investment", net_cents=2_450, abs_cents=2_450, count=1),
    ]
    totals = summarize(sums, BUCKETS)
    assert totals.flexible_pct == Decimal("1.3")  # 1.25 is a tie: half up
    assert totals.savings_rate_pct == Decimal("1.2")  # 1.225
    # A refund-only bucket is negative spending; -0.05 rounds away from zero.
    assert totals.essentials_cents == -100
    assert totals.essentials_pct == Decimal("-0.1")
