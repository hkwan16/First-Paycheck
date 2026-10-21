"""How numbers are written in explanations: the forms the verifier reads back."""

from __future__ import annotations

from decimal import Decimal

__all__ = ["dollars", "percent"]


def dollars(cents: int) -> str:
    """``180000`` -> ``$1,800.00``; negative amounts lead with the sign."""
    sign = "-" if cents < 0 else ""
    whole, part = divmod(abs(cents), 100)
    return f"{sign}${whole:,}.{part:02d}"


def percent(value: Decimal) -> str:
    """``Decimal("4.50")`` -> ``4.5%``; trailing zeros dropped."""
    text = format(value.normalize(), "f")
    return f"{text}%"
