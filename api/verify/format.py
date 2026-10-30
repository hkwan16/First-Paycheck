"""How numbers are written in explanations: the forms the verifier reads back."""

from __future__ import annotations

from decimal import Decimal

__all__ = ["dollars", "net_cost", "percent"]


def dollars(cents: int) -> str:
    """``180000`` -> ``$1,800.00``; negative amounts lead with the sign."""
    sign = "-" if cents < 0 else ""
    whole, part = divmod(abs(cents), 100)
    return f"{sign}${whole:,}.{part:02d}"


def net_cost(cents: int) -> str:
    """A yearly net cost (spec 012 rule 17): ``202500`` -> ``$2,025.00``, and a
    negative one as the amount ahead, ``-40300`` -> ``$403.00 ahead``. The sign
    is the calculator's; this only picks the words."""
    return f"{dollars(abs(cents))} ahead" if cents < 0 else dollars(cents)


def percent(value: Decimal) -> str:
    """``Decimal("4.50")`` -> ``4.5%``; trailing zeros dropped."""
    text = format(value.normalize(), "f")
    return f"{text}%"
