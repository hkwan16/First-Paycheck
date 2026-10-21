"""Field types shared by calculators and the API models that feed them."""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated

from pydantic import AfterValidator, Field

__all__ = ["MAX_CENTS", "Cents", "Percent", "PositiveCents", "PositivePercent"]

# A sanity bound well inside bigint: $1 billion. A larger amount a user types
# is a typo, and refusing it here keeps it from overflowing a column later.
MAX_CENTS = 100_000_000_000

# Integer cents. Strict, so 2708.33 and "270833" are refused, never coerced.
Cents = Annotated[int, Field(strict=True, ge=0, le=MAX_CENTS)]
PositiveCents = Annotated[int, Field(strict=True, gt=0, le=MAX_CENTS)]

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
PositivePercent = Annotated[
    Decimal,
    Field(gt=0, le=100, max_digits=5, decimal_places=2),
    AfterValidator(_two_places),
]
