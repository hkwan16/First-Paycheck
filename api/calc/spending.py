"""Spending summary roll-up (spec 007 part B): pure arithmetic over the
per-category sums the route reads with one SQL ``GROUP BY``.

Signs follow Plaid (positive is money out). Income is reported positive when
money came in; the spending buckets are net outflows, so refunds reduce them.
Transfers between the user's own accounts are left out of every total.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from decimal import ROUND_HALF_UP, Decimal, localcontext
from typing import Literal

from pydantic import BaseModel, ConfigDict

from calc.money import CONTEXT

__all__ = ["Bucket", "CategorySum", "CategoryTotal", "SpendingTotals", "summarize"]

Bucket = Literal["income", "essentials", "flexible", "savings", "other", "transfer"]
_TENTH = Decimal("0.1")


class CategorySum(BaseModel):
    """One category's transactions in the period; ``category`` None is uncategorized."""

    model_config = ConfigDict(frozen=True)

    category: str | None
    net_cents: int
    abs_cents: int
    count: int


class CategoryTotal(BaseModel):
    model_config = ConfigDict(frozen=True)

    category: str
    bucket: Bucket
    # In the bucket's direction: income positive when money came in, spending
    # positive when money went out, transfers as the sum of absolute amounts.
    total_cents: int
    count: int


class SpendingTotals(BaseModel):
    model_config = ConfigDict(frozen=True)

    income_cents: int
    essentials_cents: int
    flexible_cents: int
    savings_cents: int
    other_cents: int
    transfers_ignored_cents: int
    uncategorized_cents: int
    uncategorized_count: int
    left_over_cents: int
    essentials_pct: Decimal | None
    flexible_pct: Decimal | None
    savings_rate_pct: Decimal | None
    transaction_count: int
    categories: list[CategoryTotal]


def _share(part: int, income: int) -> Decimal | None:
    if income <= 0:
        return None
    with localcontext(CONTEXT):
        return (Decimal(part) * 100 / income).quantize(_TENTH, rounding=ROUND_HALF_UP)


def _bucket_total(bucket: Bucket, item: CategorySum) -> int:
    if bucket == "income":
        return -item.net_cents
    if bucket == "transfer":
        return item.abs_cents
    return item.net_cents


def summarize(sums: Sequence[CategorySum], buckets: Mapping[str, Bucket]) -> SpendingTotals:
    """Roll ``sums`` (in the order categories should be listed) up by bucket."""
    by_bucket: dict[Bucket, int] = dict.fromkeys(
        ("income", "essentials", "flexible", "savings", "other", "transfer"), 0
    )
    categories: list[CategoryTotal] = []
    uncategorized_cents = uncategorized_count = 0
    for item in sums:
        if item.category is None:
            uncategorized_cents += item.net_cents
            uncategorized_count += item.count
            continue
        bucket = buckets[item.category]
        total = _bucket_total(bucket, item)
        by_bucket[bucket] += total
        categories.append(
            CategoryTotal(
                category=item.category, bucket=bucket, total_cents=total, count=item.count
            )
        )
    income = by_bucket["income"]
    spent = by_bucket["essentials"] + by_bucket["flexible"] + by_bucket["other"]
    return SpendingTotals(
        income_cents=income,
        essentials_cents=by_bucket["essentials"],
        flexible_cents=by_bucket["flexible"],
        savings_cents=by_bucket["savings"],
        other_cents=by_bucket["other"],
        transfers_ignored_cents=by_bucket["transfer"],
        uncategorized_cents=uncategorized_cents,
        uncategorized_count=uncategorized_count,
        left_over_cents=income - spent - by_bucket["savings"],
        essentials_pct=_share(by_bucket["essentials"], income),
        flexible_pct=_share(by_bucket["flexible"], income),
        savings_rate_pct=_share(by_bucket["savings"], income),
        transaction_count=sum(item.count for item in sums),
        categories=categories,
    )
