"""The federal marginal rate for a taxable income (spec 006 rule 9, spec 012 rule 2)."""

from __future__ import annotations

from decimal import Decimal

from calc.data import FilingStatus, TaxYearData

__all__ = ["marginal_rate"]

_ZERO = Decimal(0)


def marginal_rate(data: TaxYearData, status: FilingStatus, taxable: Decimal | int) -> Decimal:
    """The rate of the bracket holding ``taxable``; a bound is "not over", and
    taxable income at or below zero has a rate of 0."""
    if taxable <= 0:
        return _ZERO
    for bracket in data.brackets.by_status[status]:
        if bracket.up_to_cents is None or taxable <= bracket.up_to_cents:
            return bracket.rate_pct
    raise AssertionError("the top bracket is open-ended")  # pragma: no cover
