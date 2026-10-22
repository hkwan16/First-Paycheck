"""Stage 1 of the cash-flow diagram: gross pay to deductions and take-home
(spec 010 part A, spec amendment 16).

Each confirmed pay stub becomes seven lines in a fixed order, grouped by role
(tax, retirement, health, other), and the period's lines are summed here so
the client never adds money. Amounts are the stubs' non-negative magnitudes.

``against_plan`` sets a month's actuals beside the saved decisions' targets
for the check-in screen (spec 015 rule 19), and ``plan_status`` says which
side of its plan each line is on (rule 19a).
"""

from __future__ import annotations

from collections.abc import Sequence
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from calc.money import pct_of, round_half_up
from calc.pay_stub import PayStubAmounts, balance, total_cents

__all__ = [
    "LINES",
    "PLAN_TOLERANCE_FLOOR_CENTS",
    "PLAN_TOLERANCE_PCT",
    "CashFlowWithholding",
    "DeductionRole",
    "LineSpec",
    "PlanLine",
    "PlanLineKey",
    "PlanLineStatus",
    "PlanTargets",
    "RoleTotals",
    "SpendingActuals",
    "StubFlow",
    "WithholdingLine",
    "against_plan",
    "plan_status",
    "plan_tolerance",
    "withholding",
]

Cents = Annotated[int, Field(strict=True)]
DeductionRole = Literal["tax", "retirement", "health", "other"]
LineKey = Literal[
    "federal_withholding",
    "social_security",
    "medicare",
    "state_tax",
    "retirement_contribution",
    "medical_premium",
    "other_deductions",
]


class LineSpec(BaseModel):
    model_config = ConfigDict(frozen=True)

    key: LineKey
    label: str
    role: DeductionRole


LINES: tuple[LineSpec, ...] = (
    LineSpec(key="federal_withholding", label="Federal tax", role="tax"),
    LineSpec(key="social_security", label="Social Security", role="tax"),
    LineSpec(key="medicare", label="Medicare", role="tax"),
    LineSpec(key="state_tax", label="State tax", role="tax"),
    LineSpec(key="retirement_contribution", label="401(k)", role="retirement"),
    LineSpec(key="medical_premium", label="Health premiums", role="health"),
    LineSpec(key="other_deductions", label="Other deductions", role="other"),
)


class WithholdingLine(LineSpec):
    amount_cents: Cents


class RoleTotals(BaseModel):
    model_config = ConfigDict(frozen=True)

    tax_cents: Cents
    retirement_cents: Cents
    health_cents: Cents
    other_cents: Cents


class StubFlow(BaseModel):
    """One stub's flow, or the period's sum of them."""

    model_config = ConfigDict(frozen=True)

    gross_cents: Cents
    # The seven lines of ``LINES``, in that order, zero when absent.
    lines: list[WithholdingLine]
    roles: RoleTotals
    deductions_cents: Cents
    net_cents: Cents


class CashFlowWithholding(BaseModel):
    model_config = ConfigDict(frozen=True)

    # In the order the stubs were given.
    stubs: list[StubFlow]
    total: StubFlow
    paycheck_count: int


def _flow(gross: int, line_amounts: Sequence[int], net: int) -> StubFlow:
    lines = [
        WithholdingLine(key=spec.key, label=spec.label, role=spec.role, amount_cents=amount)
        for spec, amount in zip(LINES, line_amounts, strict=True)
    ]

    def role_total(role: DeductionRole) -> int:
        return total_cents(line.amount_cents for line in lines if line.role == role)

    return StubFlow(
        gross_cents=gross,
        lines=lines,
        roles=RoleTotals(
            tax_cents=role_total("tax"),
            retirement_cents=role_total("retirement"),
            health_cents=role_total("health"),
            other_cents=role_total("other"),
        ),
        deductions_cents=total_cents(line_amounts),
        net_cents=net,
    )


def _line_amounts(stub: PayStubAmounts) -> list[int]:
    return [getattr(stub, f"{spec.key}_cents") for spec in LINES]


def withholding(stubs: Sequence[PayStubAmounts]) -> CashFlowWithholding:
    """Each stub's lines and the period's totals; raises on a stub that does
    not balance (gross minus deductions must equal net)."""
    flows: list[StubFlow] = []
    for index, stub in enumerate(stubs):
        check = balance(stub)
        if not check.balances:
            raise ValueError(
                f"pay stub {index} does not balance: gross {check.gross_cents} minus deductions"
                f" {check.deductions_cents} is {check.expected_net_cents}, net is {check.net_cents}"
            )
        flows.append(_flow(stub.gross_cents, _line_amounts(stub), stub.net_cents))
    summed = [
        total_cents(flow.lines[position].amount_cents for flow in flows)
        for position in range(len(LINES))
    ]
    total = _flow(
        total_cents(flow.gross_cents for flow in flows),
        summed,
        total_cents(flow.net_cents for flow in flows),
    )
    return CashFlowWithholding(stubs=flows, total=total, paycheck_count=len(flows))


# ---------------------------------------------------------------- against the plan (spec 015)

PlanLineKey = Literal[
    "take_home", "essentials", "flexible", "other", "savings", "retirement", "health", "left_over"
]


class SpendingActuals(BaseModel):
    """The month's spending-summary totals (spec 007 part B), as the route read them."""

    model_config = ConfigDict(frozen=True)

    take_home_cents: Cents
    essentials_cents: Cents
    flexible_cents: Cents
    other_cents: Cents
    savings_cents: Cents
    left_over_cents: Cents


class PlanTargets(BaseModel):
    """What the saved decisions planned for a month; None where nothing was decided."""

    model_config = ConfigDict(frozen=True)

    # The current 401(k) decision's deferral rate.
    contribution_pct: Decimal | None = None
    # The selected health plan's premium per paycheck.
    premium_per_period_cents: Cents | None = None
    # The emergency-fund decision's essential spending per month.
    monthly_essentials_cents: Cents | None = None
    # The active emergency-fund goal's monthly contribution.
    monthly_savings_cents: Cents | None = None


PlanLineStatus = Literal["on_plan", "over", "under"]

# Rule 19a: a line is on plan within 5% of the plan or $25, whichever is larger.
PLAN_TOLERANCE_PCT = Decimal("5")
PLAN_TOLERANCE_FLOOR_CENTS = 2_500


class PlanLine(BaseModel):
    model_config = ConfigDict(frozen=True)

    key: PlanLineKey
    label: str
    actual_cents: Cents
    plan_cents: Cents | None
    # Actual minus plan: positive when the month ran over the plan.
    difference_cents: Cents | None
    # Which side of the plan the line is on, beyond the tolerance; null without
    # a plan. Whether over is good depends on the line (spending vs saving).
    status: PlanLineStatus | None


def plan_tolerance(plan_cents: int) -> int:
    """Rule 19a: ``max(round_half_up(plan * 5 / 100), 2,500)``."""
    return max(round_half_up(pct_of(plan_cents, PLAN_TOLERANCE_PCT)), PLAN_TOLERANCE_FLOOR_CENTS)


def plan_status(actual_cents: int, plan_cents: int | None) -> PlanLineStatus | None:
    """Rule 19a: ``on_plan`` within the tolerance, else ``over`` or ``under``."""
    if plan_cents is None:
        return None
    difference = actual_cents - plan_cents
    tolerance = plan_tolerance(plan_cents)
    if difference > tolerance:
        return "over"
    if -difference > tolerance:
        return "under"
    return "on_plan"


def _line(key: PlanLineKey, label: str, actual: int, plan: int | None) -> PlanLine:
    return PlanLine(
        key=key,
        label=label,
        actual_cents=actual,
        plan_cents=plan,
        difference_cents=None if plan is None else actual - plan,
        status=plan_status(actual, plan),
    )


def _amount(flow: StubFlow, key: LineKey) -> int:
    return next(line.amount_cents for line in flow.lines if line.key == key)


def against_plan(
    total: StubFlow, paycheck_count: int, spending: SpendingActuals, targets: PlanTargets
) -> list[PlanLine]:
    """Spec 015 rule 19: each line's actual, its monthly plan and the difference.

    ``total`` is the period's summed stub flow (``withholding(...).total``).
    The retirement plan is the elected rate on the period's actual gross; the
    health plan is the premium times the paychecks in the period.
    """
    retirement_plan = (
        None
        if targets.contribution_pct is None
        else round_half_up(pct_of(total.gross_cents, targets.contribution_pct))
    )
    health_plan = (
        None
        if targets.premium_per_period_cents is None
        else targets.premium_per_period_cents * paycheck_count
    )
    return [
        _line("take_home", "Take-home pay", spending.take_home_cents, None),
        _line(
            "essentials", "Essentials", spending.essentials_cents, targets.monthly_essentials_cents
        ),
        _line("flexible", "Flexible", spending.flexible_cents, None),
        _line("other", "Other spending", spending.other_cents, None),
        _line("savings", "Savings", spending.savings_cents, targets.monthly_savings_cents),
        _line(
            "retirement",
            "401(k) from pay stubs",
            _amount(total, "retirement_contribution"),
            retirement_plan,
        ),
        _line("health", "Health premiums", _amount(total, "medical_premium"), health_plan),
        _line("left_over", "Left over", spending.left_over_cents, None),
    ]
