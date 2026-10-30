"""The health plan comparison calculator (spec 012).

``health_plans(HealthPlansInput) -> HealthPlansResult`` is pure. For each plan
it works out the expected annual net cost (premiums plus out-of-pocket spending
minus the employer's HSA contribution and the federal income tax the user's own
HSA contribution saves) at three usage scenarios, and for each pair of plans it
scans annual spending in $100 steps to find where the cheaper plan changes.
Every intermediate value is an exact ``Decimal``; each output is rounded once,
half up, to whole cents.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable, Sequence
from decimal import Decimal, localcontext
from itertools import combinations
from typing import Annotated, Literal, Self

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from calc.brackets import marginal_rate
from calc.data import FilingStatus, HsaLimits, UnknownTaxYear, tax_year
from calc.money import CONTEXT, pct_of, round_half_up
from calc.types import Cents, PayPeriods, Percent, PositiveCents, ResultPercent, SignedCents

# A person reaches these by typing a plan, and the API shows them as they are
# (spec 008 rule 22a), so they are sentences. The benefits confirm shares them.
DEDUCTIBLE_OVER_OOP = "A plan's deductible must not be more than its out-of-pocket maximum"
HSA_WITHOUT_HDHP = "Only a high-deductible plan can have an employer HSA contribution"

__all__ = [
    "BASE_CITATION_KEYS",
    "DEDUCTIBLE_OVER_OOP",
    "HDHP_CITATION_KEYS",
    "HSA_WITHOUT_HDHP",
    "MAX_PLANS",
    "SCAN_LIMIT_CENTS",
    "SCAN_STEP_CENTS",
    "HealthPlanOption",
    "HealthPlansInput",
    "HealthPlansResult",
    "PlanCost",
    "PlanKind",
    "PlanPair",
    "Usage",
    "health_plans",
]

PlanKind = Literal["hdhp", "ppo", "hmo"]
Usage = Literal["low", "medium", "high"]
MAX_PLANS = 8
# Rule 8: spending is scanned in $100 steps up to at most $1,000,000.
SCAN_STEP_CENTS = 10_000
SCAN_LIMIT_CENTS = 100_000_000
# Rule 11, in this order.
BASE_CITATION_KEYS = ("health.federal_brackets",)
HDHP_CITATION_KEYS = ("health.hdhp_definition", "health.hsa_limit", "health.federal_brackets")

_ZERO = Decimal(0)
_HUNDRED = Decimal(100)

PlanName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class HealthPlanOption(BaseModel):
    """One plan the employer offers, employee-only coverage, in network."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    name: PlanName
    kind: PlanKind
    premium_per_period_cents: Cents = Field(description="The employee's premium per paycheck")
    deductible_cents: Cents
    coinsurance_pct: Percent = Field(description="The member's share after the deductible")
    oop_max_cents: Cents = Field(description="The out-of-pocket maximum")
    employer_hsa_cents: Cents = Field(description="The employer's annual HSA contribution")

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if self.deductible_cents > self.oop_max_cents:
            raise ValueError(DEDUCTIBLE_OVER_OOP)
        if self.employer_hsa_cents > 0 and self.kind != "hdhp":
            raise ValueError(HSA_WITHOUT_HDHP)
        return self


class HealthPlansInput(BaseModel):
    """The calculator's inputs, exactly as spec 012 lists them."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    plans: list[HealthPlanOption] = Field(min_length=1, max_length=MAX_PLANS)
    pay_periods_per_year: PayPeriods
    salary_cents: PositiveCents = Field(description="Annual salary, for the marginal rate")
    filing_status: FilingStatus
    tax_year: int = Field(strict=True, description="The pay stub's tax year")
    employee_hsa_cents: Cents = Field(
        description="What the user plans to put into an HSA in the year themselves"
    )
    expected_usage: Usage
    usage_low_cents: Cents = Field(default=50_000, description="Annual medical spending, low")
    usage_medium_cents: Cents = Field(
        default=300_000, description="Annual medical spending, medium"
    )
    usage_high_cents: Cents = Field(default=1_000_000, description="Annual medical spending, high")
    selected_plan_index: int | None = Field(
        default=None, strict=True, ge=0, description="The plan the user picks"
    )
    enrollment_deadline: dt.date | None = Field(
        default=None, description="The last day to enroll; used only when the decision is saved"
    )

    @field_validator("tax_year")
    @classmethod
    def _known_year(cls, value: int) -> int:
        try:
            tax_year(value)
        except UnknownTaxYear as exc:
            raise ValueError(f"no federal constants for tax year {value}") from exc
        return value

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if not self.usage_low_cents < self.usage_medium_cents < self.usage_high_cents:
            raise ValueError(
                "Low, medium and high medical use must each be more than the one before"
            )
        if self.selected_plan_index is not None and self.selected_plan_index >= len(self.plans):
            raise ValueError("The plan chosen must be one of the plans compared")
        return self


class PlanCost(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str
    kind: PlanKind
    annual_premium_cents: Cents
    hsa_eligible: bool
    employer_hsa_cents: Cents
    employee_hsa_cents: Cents
    hsa_capped: bool
    hsa_tax_savings_cents: Cents
    low_cost_cents: SignedCents
    medium_cost_cents: SignedCents
    high_cost_cents: SignedCents
    worst_case_cents: SignedCents


class PlanPair(BaseModel):
    model_config = ConfigDict(frozen=True)

    plan_a_index: int
    plan_b_index: int
    cheaper_at_zero_index: int | None
    break_even_spends_cents: list[Cents] = Field(
        description="Every scanned annual spend at which the cheaper plan changes"
    )
    cheaper_at_end_index: int | None


class HealthPlansResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    marginal_rate_used: ResultPercent
    hsa_limit_cents: Cents
    hdhp_min_deductible_cents: Cents
    hdhp_max_oop_cents: Cents
    plans: list[PlanCost]
    pairs: list[PlanPair]
    recommended_index: int
    selected_index: int | None
    scan_step_cents: Cents
    scan_end_cents: Cents
    citation_keys: list[str]


Cost = Callable[[int], Decimal]


def _eligible(plan: HealthPlanOption, hsa: HsaLimits) -> bool:
    """Rule 3: an HDHP that meets the year's self-only thresholds."""
    return (
        plan.kind == "hdhp"
        and plan.deductible_cents >= hsa.hdhp_min_deductible_self_cents
        and plan.oop_max_cents <= hsa.hdhp_max_oop_self_cents
    )


def _out_of_pocket(plan: HealthPlanOption, spend: int) -> Decimal:
    """Rule 6."""
    if spend <= plan.deductible_cents:
        paid = Decimal(spend)
    else:
        paid = plan.deductible_cents + pct_of(spend - plan.deductible_cents, plan.coinsurance_pct)
    return min(paid, Decimal(plan.oop_max_cents))


def _cap(plan: HealthPlanOption) -> Decimal:
    """Rule 8: the spend at which the plan reaches its out-of-pocket maximum."""
    if plan.coinsurance_pct == 0:
        return Decimal(plan.deductible_cents)
    gap = plan.oop_max_cents - plan.deductible_cents
    return plan.deductible_cents + Decimal(gap) * _HUNDRED / plan.coinsurance_pct


def _scan_end(plans: Sequence[HealthPlanOption]) -> int:
    farthest = max(_cap(plan) for plan in plans)
    steps = -(-farthest // SCAN_STEP_CENTS)  # ceiling division, exact
    return min(SCAN_LIMIT_CENTS, int(steps) * SCAN_STEP_CENTS)


def _cheaper(a: int, b: int, cost_a: Decimal, cost_b: Decimal) -> int | None:
    if cost_a < cost_b:
        return a
    if cost_b < cost_a:
        return b
    return None


def _pair(a: int, b: int, costs: Sequence[Sequence[Decimal]], points: Sequence[int]) -> PlanPair:
    """Rule 9: where the cheaper plan of ``a`` and ``b`` changes along the scan."""
    winners = [_cheaper(a, b, costs[a][k], costs[b][k]) for k in range(len(points))]
    changes = [points[k] for k in range(1, len(points)) if winners[k] != winners[k - 1]]
    return PlanPair(
        plan_a_index=a,
        plan_b_index=b,
        cheaper_at_zero_index=winners[0],
        break_even_spends_cents=changes,
        cheaper_at_end_index=winners[-1],
    )


def health_plans(data: HealthPlansInput) -> HealthPlansResult:
    year = tax_year(data.tax_year)
    hsa = year.hsa
    scenarios: dict[Usage, int] = {
        "low": data.usage_low_cents,
        "medium": data.usage_medium_cents,
        "high": data.usage_high_cents,
    }
    with localcontext(CONTEXT):
        taxable = data.salary_cents - year.standard_deduction.cents[data.filing_status]
        rate = marginal_rate(year, data.filing_status, taxable)

        results: list[PlanCost] = []
        cost_of: list[Cost] = []
        for plan in data.plans:
            eligible = _eligible(plan, hsa)
            room = max(0, hsa.self_only_limit_cents - plan.employer_hsa_cents)
            employee = min(data.employee_hsa_cents, room) if eligible else 0
            tax = pct_of(employee, rate)
            fixed = (
                Decimal(plan.premium_per_period_cents * data.pay_periods_per_year)
                - plan.employer_hsa_cents
                - tax
            )

            def cost(spend: int, plan: HealthPlanOption = plan, fixed: Decimal = fixed) -> Decimal:
                return fixed + _out_of_pocket(plan, spend)

            cost_of.append(cost)
            results.append(
                PlanCost(
                    name=plan.name,
                    kind=plan.kind,
                    annual_premium_cents=plan.premium_per_period_cents * data.pay_periods_per_year,
                    hsa_eligible=eligible,
                    employer_hsa_cents=plan.employer_hsa_cents,
                    employee_hsa_cents=employee,
                    hsa_capped=eligible and data.employee_hsa_cents > employee,
                    hsa_tax_savings_cents=round_half_up(tax),
                    low_cost_cents=round_half_up(cost(scenarios["low"])),
                    medium_cost_cents=round_half_up(cost(scenarios["medium"])),
                    high_cost_cents=round_half_up(cost(scenarios["high"])),
                    worst_case_cents=round_half_up(fixed + plan.oop_max_cents),
                )
            )

        end = _scan_end(data.plans)
        points = range(0, end + 1, SCAN_STEP_CENTS)
        grid = (
            [[cost(point) for point in points] for cost in cost_of] if len(data.plans) > 1 else []
        )
        pairs = [_pair(a, b, grid, points) for a, b in combinations(range(len(data.plans)), 2)]

        expected = scenarios[data.expected_usage]
        recommended = min(
            range(len(data.plans)), key=lambda index: (cost_of[index](expected), index)
        )
        keys = (
            HDHP_CITATION_KEYS if any(p.kind == "hdhp" for p in data.plans) else BASE_CITATION_KEYS
        )
        return HealthPlansResult(
            marginal_rate_used=rate,
            hsa_limit_cents=hsa.self_only_limit_cents,
            hdhp_min_deductible_cents=hsa.hdhp_min_deductible_self_cents,
            hdhp_max_oop_cents=hsa.hdhp_max_oop_self_cents,
            plans=results,
            pairs=pairs,
            recommended_index=recommended,
            selected_index=data.selected_plan_index,
            scan_step_cents=SCAN_STEP_CENTS,
            scan_end_cents=end,
            citation_keys=list(keys),
        )
