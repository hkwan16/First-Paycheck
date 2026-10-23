"""Spending summary roll-up (spec 007 part B): pure arithmetic over the
per-category sums the route reads with one SQL ``GROUP BY``.

Signs follow Plaid (positive is money out). Income counts money in only and
is reported positive (rule 22a): an income-labeled row that is money out, such
as the Plaid sandbox's GUSTO PAY payroll, is not income and is left out of every
total like a transfer, so income is never negative. The spending buckets are
net outflows, so refunds reduce them. Transfers between the user's own
accounts are left out of every total. The sums cover checking, savings and
credit accounts only (rule 21a); the route leaves loan, investment and
retirement ledgers out before they get here.

A share of income is null when there is no income, or when its size would
exceed ``MAX_SHARE_PCT`` (rule 25): a few cents deposited against a month of
spending gives a percentage that says nothing.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from decimal import ROUND_HALF_UP, Decimal, localcontext
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from calc.money import CONTEXT

__all__ = [
    "MAX_SHARE_PCT",
    "Bucket",
    "CategorySum",
    "CategoryTotal",
    "SpendingTotals",
    "summarize",
]

Bucket = Literal["income", "essentials", "flexible", "savings", "other", "transfer"]
_TENTH = Decimal("0.1")
# Rule 25: the largest share of income shown, in percent, either sign.
MAX_SHARE_PCT = 1_000

# A sum of amounts in one direction: never negative, and never bounded the way
# a typed amount is (a year of transactions can add up past any one of them).
Magnitude = Annotated[int, Field(strict=True, ge=0)]


class CategorySum(BaseModel):
    """One category's transactions in the period; ``category`` None is uncategorized.

    Money out and money in are kept apart (both as magnitudes) because the
    income bucket counts money in only.
    """

    model_config = ConfigDict(frozen=True)

    category: str | None
    # The sum of the positive amounts (money out).
    out_cents: Magnitude
    # The sum of the magnitudes of the negative amounts (money in).
    in_cents: Magnitude
    count: Magnitude
    # How many of ``count`` are money out (amount above 0).
    out_count: Magnitude

    @model_validator(mode="after")
    def _out_count_within_count(self) -> Self:
        if self.out_count > self.count:
            raise ValueError("out_count cannot exceed count")
        return self

    @property
    def net_cents(self) -> int:
        """Positive is money out, as Plaid signs it."""
        return self.out_cents - self.in_cents


class CategoryTotal(BaseModel):
    model_config = ConfigDict(frozen=True)

    category: str
    bucket: Bucket
    # In the bucket's direction: income as the money that came in, spending
    # positive when money went out, transfers as the sum of absolute amounts.
    total_cents: int
    # The transactions behind ``total_cents`` (income leaves out its money out).
    count: int


class SpendingTotals(BaseModel):
    model_config = ConfigDict(frozen=True)

    income_cents: int
    essentials_cents: int
    flexible_cents: int
    savings_cents: int
    other_cents: int
    transfers_ignored_cents: int
    # Income-labeled money out, left out of every total (rule 22a).
    income_outflows_ignored_cents: int
    uncategorized_cents: int
    uncategorized_count: int
    left_over_cents: int
    # One decimal place; null with no income or too little to compare (rule 25).
    essentials_pct: Decimal | None
    flexible_pct: Decimal | None
    savings_rate_pct: Decimal | None
    transaction_count: int
    categories: list[CategoryTotal]


def _share(part: int, income: int) -> Decimal | None:
    """``part`` as a percentage of ``income``, or None when there is no income
    or the share's size would exceed ``MAX_SHARE_PCT`` (compared exactly, in
    cents, before rounding)."""
    if income <= 0 or abs(part) * 100 > MAX_SHARE_PCT * income:
        return None
    with localcontext(CONTEXT):
        return (Decimal(part) * 100 / income).quantize(_TENTH, rounding=ROUND_HALF_UP)


def _bucket_total(bucket: Bucket, item: CategorySum) -> tuple[int, int]:
    """What ``item`` adds to its bucket, and how many transactions that is."""
    if bucket == "income":
        return item.in_cents, item.count - item.out_count
    if bucket == "transfer":
        return item.out_cents + item.in_cents, item.count
    return item.net_cents, item.count


def summarize(sums: Sequence[CategorySum], buckets: Mapping[str, Bucket]) -> SpendingTotals:
    """Roll ``sums`` (in the order categories should be listed) up by bucket."""
    by_bucket: dict[Bucket, int] = dict.fromkeys(
        ("income", "essentials", "flexible", "savings", "other", "transfer"), 0
    )
    categories: list[CategoryTotal] = []
    uncategorized_cents = uncategorized_count = income_outflows = 0
    for item in sums:
        if item.category is None:
            uncategorized_cents += item.net_cents
            uncategorized_count += item.count
            continue
        bucket = buckets[item.category]
        if bucket == "income":
            income_outflows += item.out_cents
        total, count = _bucket_total(bucket, item)
        by_bucket[bucket] += total
        if count:
            categories.append(
                CategoryTotal(category=item.category, bucket=bucket, total_cents=total, count=count)
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
        income_outflows_ignored_cents=income_outflows,
        uncategorized_cents=uncategorized_cents,
        uncategorized_count=uncategorized_count,
        left_over_cents=income - spent - by_bucket["savings"],
        essentials_pct=_share(by_bucket["essentials"], income),
        flexible_pct=_share(by_bucket["flexible"], income),
        savings_rate_pct=_share(by_bucket["savings"], income),
        transaction_count=sum(item.count for item in sums),
        categories=categories,
    )
