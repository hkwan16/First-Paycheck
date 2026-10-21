"""Amount arithmetic for recurring-charge detection (spec 009 rules 5, 7 and 12).

Integer cents in, integer cents or booleans out. Percentage tests compare
``100 * difference`` with ``pct * reference`` in integers, so no division and
no rounding decide whether an amount fits.
"""

from __future__ import annotations

from collections.abc import Sequence
from decimal import Decimal

from calc.money import CONTEXT, round_half_up

__all__ = ["median_cents", "moved_more_than", "within_pct"]


def median_cents(values: Sequence[int]) -> int:
    """The middle amount; for an even count, the mean of the middle two, half up."""
    if not values:
        raise ValueError("the median of an empty list is undefined")
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    pair = Decimal(ordered[middle - 1]) + Decimal(ordered[middle])
    return round_half_up(CONTEXT.divide(pair, Decimal(2)))


def _check_reference(reference: int) -> None:
    if reference <= 0:
        raise ValueError(f"the reference amount must be positive, not {reference}")


def within_pct(amount: int, reference: int, pct: int) -> bool:
    """``amount`` is within ``pct`` percent of ``reference`` (inclusive)."""
    _check_reference(reference)
    return 100 * abs(amount - reference) <= pct * reference


def moved_more_than(new: int, old: int, pct: int) -> bool:
    """``new`` differs from ``old`` by more than ``pct`` percent of ``old``."""
    _check_reference(old)
    return 100 * abs(new - old) > pct * old
