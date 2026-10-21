"""Field types shared by calculators and the API models that feed them."""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Literal

from pydantic import AfterValidator, Field

__all__ = [
    "MAX_CENTS",
    "Cents",
    "PayPeriods",
    "Percent",
    "PositiveCents",
    "PositivePercent",
    "ResultPercent",
    "SignedCents",
]

# A sanity bound well inside bigint: $1 billion. A larger amount a user types
# is a typo, and refusing it here keeps it from overflowing a column later.
MAX_CENTS = 100_000_000_000

# Integer cents. Strict, so 2708.33 and "270833" are refused, never coerced.
Cents = Annotated[int, Field(strict=True, ge=0, le=MAX_CENTS)]
PositiveCents = Annotated[int, Field(strict=True, gt=0, le=MAX_CENTS)]
# An amount that can fall below zero, such as a net cost an employer's HSA
# contribution more than covers.
SignedCents = Annotated[int, Field(strict=True, ge=-MAX_CENTS, le=MAX_CENTS)]

# Paychecks per year: monthly, semimonthly, biweekly, weekly.
PayPeriods = Literal[12, 24, 26, 52]

_HUNDREDTH = Decimal("0.01")


def _two_places(value: Decimal) -> Decimal:
    # Stored and returned with exactly two places: "6" and "6.0" both become "6.00".
    return value.quantize(_HUNDREDTH)


# A percentage from 0 to 100 with at most two decimal places, as a Decimal
# (never a float); JSON carries it as a string.
Percent = Annotated[
    Decimal,
    Field(ge=0, le=100, max_digits=5, decimal_places=2),
    AfterValidator(_two_places),
]
# A rate a calculator reports, with exactly two places ("5.00").
ResultPercent = Annotated[Decimal, AfterValidator(_two_places)]
PositivePercent = Annotated[
    Decimal,
    Field(gt=0, le=100, max_digits=5, decimal_places=2),
    AfterValidator(_two_places),
]
