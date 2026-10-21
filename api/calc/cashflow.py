"""Stage 1 of the cash-flow diagram: gross pay to deductions and take-home
(spec 010 part A, spec amendment 16).

Each confirmed pay stub becomes seven lines in a fixed order, grouped by role
(tax, retirement, health, other), and the period's lines are summed here so
the client never adds money. Amounts are the stubs' non-negative magnitudes.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from calc.pay_stub import PayStubAmounts, balance, total_cents

__all__ = [
    "LINES",
    "CashFlowWithholding",
    "DeductionRole",
    "LineSpec",
    "RoleTotals",
    "StubFlow",
    "WithholdingLine",
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
