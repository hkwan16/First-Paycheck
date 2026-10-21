"""The emergency fund calculator (spec 011).

``emergency_fund(EmergencyFundInput) -> EmergencyFundResult`` is pure: the
monthly essentials and the current balance arrive as inputs (the client sends
what the user confirmed), never read from the database here. Notation follows
the spec: ``E`` essentials, ``m`` target months, ``B`` balance, ``C`` monthly
contribution, ``P`` pay periods, ``H`` the 120-month horizon.
"""

from __future__ import annotations

from decimal import Decimal, localcontext

from pydantic import BaseModel, ConfigDict, Field

from calc.money import CONTEXT, per_period, round_half_up
from calc.types import Cents, PayPeriods, PositiveCents, ResultPercent

__all__ = [
    "HORIZON_MONTHS",
    "MAX_TARGET_MONTHS",
    "EmergencyFundInput",
    "EmergencyFundResult",
    "emergency_fund",
    "funded_pct",
]

# Rule 4: the longest projection, in months (10 years).
HORIZON_MONTHS = 120
MAX_TARGET_MONTHS = 12
_HUNDRED = Decimal(100)
_HUNDREDTH = Decimal("0.01")


class EmergencyFundInput(BaseModel):
    """The calculator's inputs, exactly as spec 011 lists them."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    monthly_essentials_cents: PositiveCents = Field(
        description="Essential spending per month, as the user confirmed it"
    )
    target_months: int = Field(
        strict=True,
        ge=1,
        le=MAX_TARGET_MONTHS,
        description="Months of essentials the fund should hold; 3 to 6 is suggested",
    )
    current_balance_cents: Cents = Field(description="What the fund holds today")
    monthly_contribution_cents: Cents = Field(description="What the user adds each month")
    pay_periods_per_year: PayPeriods


class EmergencyFundResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    target_cents: Cents
    three_month_target_cents: Cents
    six_month_target_cents: Cents
    shortfall_cents: Cents
    funded: bool
    funded_pct: ResultPercent = Field(
        description="The balance as a share of the target, in percent, at most 100"
    )
    months_to_target: int | None = Field(
        description="Monthly contributions that close the shortfall; 0 when funded;"
        " null when it takes more than horizon_months or never happens"
    )
    reachable: bool
    per_paycheck_contribution_cents: Cents
    horizon_months: int


def funded_pct(balance_cents: int, target_cents: int) -> Decimal:
    """Rule 3: ``min(100, balance / target * 100)``, two places, half up."""
    if target_cents <= 0:
        raise ValueError(f"target_cents must be positive, not {target_cents}")
    with localcontext(CONTEXT):
        share = min(_HUNDRED, Decimal(max(0, balance_cents)) / Decimal(target_cents) * _HUNDRED)
        return share.quantize(_HUNDREDTH)


def _months_to_target(shortfall: int, contribution: int) -> int | None:
    """Rule 4, in integers: the fewest whole months that close ``shortfall``."""
    if shortfall == 0:
        return 0
    if contribution == 0:
        return None
    months = (shortfall + contribution - 1) // contribution
    return months if months <= HORIZON_MONTHS else None


def emergency_fund(data: EmergencyFundInput) -> EmergencyFundResult:
    essentials = data.monthly_essentials_cents
    target = essentials * data.target_months
    shortfall = max(0, target - data.current_balance_cents)
    months = _months_to_target(shortfall, data.monthly_contribution_cents)
    with localcontext(CONTEXT):
        per_paycheck = per_period(data.monthly_contribution_cents * 12, data.pay_periods_per_year)
        return EmergencyFundResult(
            target_cents=target,
            three_month_target_cents=3 * essentials,
            six_month_target_cents=6 * essentials,
            shortfall_cents=shortfall,
            funded=shortfall == 0,
            funded_pct=funded_pct(data.current_balance_cents, target),
            months_to_target=months,
            reachable=months is not None,
            per_paycheck_contribution_cents=round_half_up(per_paycheck),
            horizon_months=HORIZON_MONTHS,
        )
