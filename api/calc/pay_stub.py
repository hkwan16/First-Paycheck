"""Pay stub arithmetic: the confirm gate (spec 005 rule 21, spec amendment 17)
and the yearly salary a stub implies (spec 005 rule 24a).

Gross minus every deduction must equal net, to the cent. The server checks it
on ``POST /docs/{id}/confirm`` (a 422 with this diff), the client checks it as
the user edits, and the ``pay_stub_balances`` constraint is the backstop.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

from calc.pay_dates import PERIODS, PayFrequency

Cents = Annotated[int, Field(strict=True)]

__all__ = ["Balance", "PayStubAmounts", "annual_salary_cents", "balance", "total_cents"]


class PayStubAmounts(BaseModel):
    model_config = ConfigDict(frozen=True)

    gross_cents: Cents
    federal_withholding_cents: Cents
    social_security_cents: Cents
    medicare_cents: Cents
    state_tax_cents: Cents
    retirement_contribution_cents: Cents
    medical_premium_cents: Cents
    other_deductions_cents: Cents
    net_cents: Cents


class Balance(BaseModel):
    model_config = ConfigDict(frozen=True)

    gross_cents: Cents
    deductions_cents: Cents
    net_cents: Cents
    # What net would be if every other amount is right.
    expected_net_cents: Cents
    # gross - deductions - net; zero when the stub balances.
    difference_cents: Cents

    @property
    def balances(self) -> bool:
        return self.difference_cents == 0


def total_cents(amounts: Iterable[int]) -> int:
    return sum(amounts, 0)


def annual_salary_cents(gross_cents: int, pay_frequency: PayFrequency | None) -> int | None:
    """Gross pay times the pay periods a year (spec 005 rule 24a).

    An integer product, so nothing is rounded: 270,833 twice a month is
    6,499,992, not 6,500,000. None without a pay frequency.
    """
    if pay_frequency is None:
        return None
    return gross_cents * PERIODS[pay_frequency]


def balance(amounts: PayStubAmounts) -> Balance:
    deductions = total_cents(
        (
            amounts.federal_withholding_cents,
            amounts.social_security_cents,
            amounts.medicare_cents,
            amounts.state_tax_cents,
            amounts.retirement_contribution_cents,
            amounts.medical_premium_cents,
            amounts.other_deductions_cents,
        )
    )
    expected = amounts.gross_cents - deductions
    return Balance(
        gross_cents=amounts.gross_cents,
        deductions_cents=deductions,
        net_cents=amounts.net_cents,
        expected_net_cents=expected,
        difference_cents=expected - amounts.net_cents,
    )
