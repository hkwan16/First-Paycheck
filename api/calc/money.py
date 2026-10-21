"""Money arithmetic: exact ``Decimal`` intermediates, one half-up rounding at the end.

Amounts are integer cents. Rates are ``Decimal`` percent points (``4.5`` is
4.5%). Intermediate values stay exact ``Decimal`` (division runs at 50
significant digits, far beyond any cent), and each output is rounded once with
``round_half_up``. Floats never appear: ``tests/unit/calc/test_money.py``
fails on any float in ``calc/``.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Context, Decimal

__all__ = ["CONTEXT", "pct_of", "per_period", "round_half_up"]

# Every calculator divides in this context: 50 significant digits leaves no
# room for a quotient to land on the wrong side of a half cent.
CONTEXT = Context(prec=50, rounding=ROUND_HALF_UP)
_ONE = Decimal(1)


def round_half_up(value: Decimal) -> int:
    """Whole cents, ties away from zero (0.5 -> 1, -0.5 -> -1)."""
    if not isinstance(value, Decimal):
        raise TypeError(f"round_half_up takes a Decimal, not {type(value).__name__}")
    return int(value.quantize(_ONE, rounding=ROUND_HALF_UP))


def pct_of(amount: int | Decimal, pct: Decimal) -> Decimal:
    """``pct`` percent of ``amount``, exactly (a product of finite decimals)."""
    return CONTEXT.divide(CONTEXT.multiply(Decimal(amount), pct), Decimal(100))


def per_period(amount: int | Decimal, periods: int) -> Decimal:
    """``amount`` spread over ``periods`` pay periods, unrounded."""
    if periods <= 0:
        raise ValueError(f"periods must be positive, not {periods}")
    return CONTEXT.divide(Decimal(amount), Decimal(periods))
