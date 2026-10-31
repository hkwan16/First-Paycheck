"""The W-4 withholding calculator (spec 014).

``w4(W4Input) -> W4Result`` is pure. Withholding follows IRS Publication 15-T's
percentage method for automated payroll systems (Worksheet 1A and the annual
tables in ``calc/data/pub15t_<year>.json``); the projected tax follows the tax
year's brackets and standard deduction (``calc/data/<year>.json``). The
suggestion finds the whole-dollar Step 4(c), or failing that Step 4(b), entry
that brings the projected refund or balance due closest to zero. Rule 10a sets
beside it the refund or balance due at the withholding the newest confirmed
pay stub shows, against the same tax. Every
intermediate value is an exact ``Decimal``; each output is rounded once, half
up, to whole cents.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_CEILING, ROUND_FLOOR, Decimal, localcontext
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from calc.brackets import income_tax
from calc.data import (
    FilingStatus,
    Pub15T,
    TaxYearData,
    UnknownTaxYear,
    WithholdingRow,
    pub15t,
    tax_year,
)
from calc.k401 import deferral_limit_cents
from calc.money import CONTEXT, pct_of, round_half_up
from calc.types import Cents, PayPeriods, Percent, PositiveCents, ResultPercent, SignedCents

__all__ = [
    "BASE_CITATION_KEYS",
    "DEPENDENTS_CREDIT_KEY",
    "MULTIPLE_JOBS_KEY",
    "PRETAX_DEFERRAL_KEY",
    "TARGET_CENTS",
    "AtWithholding",
    "Schedule",
    "Suggestion",
    "W4Input",
    "W4Result",
    "at_withholding",
    "w4",
]

Schedule = Literal["standard", "step2_checkbox"]
Suggestion = Literal[
    "none", "increase_extra_withholding", "decrease_extra_withholding", "increase_deductions"
]

# Rule 11: a projection within $100 of zero needs no change.
TARGET_CENTS = 10_000
# Rule 15, in this order.
BASE_CITATION_KEYS = (
    "w4.percentage_method",
    "w4.form_adjustments",
    "w4.standard_deduction",
    "w4.federal_brackets",
)
MULTIPLE_JOBS_KEY = "w4.multiple_jobs"
DEPENDENTS_CREDIT_KEY = "w4.dependents_credit"
PRETAX_DEFERRAL_KEY = "w4.pretax_deferral"

_ZERO = Decimal(0)
_HUNDRED = Decimal(100)


class W4Input(BaseModel):
    """The calculator's inputs, exactly as spec 014 lists them."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    salary_cents: PositiveCents = Field(description="Annual salary from this job")
    pay_periods_per_year: PayPeriods
    filing_status: FilingStatus = Field(description="Form W-4 Step 1(c)")
    tax_year: int = Field(strict=True, description="The pay stub's tax year")
    k401_contribution_pct: Percent = Field(
        default=Decimal(0), description="Pre-tax 401(k) rate, from the saved 401(k) decision"
    )
    age: int | None = Field(
        default=None,
        strict=True,
        ge=0,
        le=130,
        description="Age reached by December 31 of tax_year, for the 401(k) catch-up",
    )
    health_premium_per_paycheck_cents: Cents = Field(
        default=0, description="Pre-tax health premium per paycheck, from the saved health plan"
    )
    multiple_jobs: bool = Field(default=False, description="Step 2(c) is checked")
    dependents_credit_cents: Cents = Field(default=0, description="Step 3, for the year")
    other_income_cents: Cents = Field(default=0, description="Step 4(a), for the year")
    deductions_cents: Cents = Field(default=0, description="Step 4(b), for the year")
    extra_withholding_cents: Cents = Field(default=0, description="Step 4(c), per paycheck")
    expected_deductions_cents: Cents | None = Field(
        default=None,
        description="Deductions beyond the standard deduction expected on the return;"
        " null means the Step 4(b) entry",
    )
    other_jobs_wages_cents: Cents = Field(
        default=0, description="The household's other jobs' annual wages, for the projection"
    )
    other_jobs_withholding_cents: Cents = Field(
        default=0, description="Federal income tax those jobs withhold in the year"
    )
    current_withholding_per_paycheck_cents: Cents | None = Field(
        default=None,
        description="Federal income tax withheld each paycheck now, from the newest confirmed"
        " pay stub, for the comparison only; null means none to compare with",
    )

    @field_validator("tax_year")
    @classmethod
    def _known_year(cls, value: int) -> int:
        try:
            tax_year(value)
            pub15t(value)
        except UnknownTaxYear as exc:
            raise ValueError(f"no federal withholding constants for tax year {value}") from exc
        return value

    @model_validator(mode="after")
    def _wages_cover_deductions(self) -> Self:
        if _taxable_wages(self, tax_year(self.tax_year)) < 0:
            raise ValueError("the 401(k) deferral and health premiums exceed the salary")
        return self


class W4Result(BaseModel):
    # The rule 10a fields default to null so a result stored before them still
    # validates (spec 014 rule 17a); every response sends them all the same.
    model_config = ConfigDict(frozen=True, json_schema_serialization_defaults_required=True)

    k401_annual_cents: Cents
    k401_capped: bool
    health_premium_annual_cents: Cents
    taxable_wages_per_paycheck_cents: Cents = Field(description="Worksheet 1A line 1a")
    adjusted_annual_wage_cents: Cents = Field(description="Worksheet 1A line 1i")
    withholding_schedule: Schedule
    withholding_rate_pct: ResultPercent = Field(description="Column D of the row used")
    withholding_per_paycheck_cents: Cents = Field(description="Worksheet 1A line 4b")
    annual_withholding_cents: Cents
    projected_taxable_income_cents: Cents
    projected_tax_cents: Cents
    projected_tax_after_credits_cents: Cents
    projected_refund_cents: SignedCents = Field(
        description="Positive is a refund, negative a balance due"
    )
    current_annual_withholding_cents: Cents | None = Field(
        default=None,
        description="Withheld in the year if every paycheck withholds the current amount;"
        " null without one",
    )
    current_refund_cents: SignedCents | None = Field(
        default=None,
        description="The refund (negative, balance due) at the current withholding, against"
        " the same tax; null without it",
    )
    suggestion: Suggestion
    suggested_extra_withholding_cents: Cents = Field(description="Step 4(c) to use, per paycheck")
    suggested_deductions_cents: Cents = Field(description="Step 4(b) to use, for the year")
    suggested_refund_cents: SignedCents
    citation_keys: list[str]


class AtWithholding(BaseModel):
    """Rule 10a at one withholding per paycheck: the year's withholding and the
    refund (negative, balance due) against the projected tax."""

    model_config = ConfigDict(frozen=True)

    annual_withholding_cents: Cents
    refund_cents: SignedCents


def _at(per_paycheck_cents: int, periods: int, other_cents: int) -> AtWithholding:
    """``other_cents`` is the refund apart from this job's withholding: the other
    jobs' withholding less the tax after credits."""
    annual = per_paycheck_cents * periods
    return AtWithholding(annual_withholding_cents=annual, refund_cents=annual + other_cents)


def at_withholding(data: W4Input, result: W4Result, per_paycheck_cents: int) -> AtWithholding:
    """Rule 10a's figures if every paycheck withholds ``per_paycheck_cents``,
    against the tax in ``result`` (``w4(data)``, or a saved decision's result,
    which may predate rule 10a). The explanation states them (spec 008 rule 7b)."""
    return _at(
        per_paycheck_cents,
        data.pay_periods_per_year,
        data.other_jobs_withholding_cents - result.projected_tax_after_credits_cents,
    )


def _deferral(data: W4Input, year: TaxYearData) -> tuple[Decimal, bool]:
    """Rule 1: the level pre-tax deferral, capped at the deferral limit."""
    limit = deferral_limit_cents(year.k401, data.age if data.age is not None else 0)
    requested = pct_of(data.salary_cents, data.k401_contribution_pct)
    return min(requested, Decimal(limit)), requested > limit


def _taxable_wages(data: W4Input, year: TaxYearData) -> Decimal:
    """Rule 2: ``W``, the year's wages subject to income tax withholding."""
    with localcontext(CONTEXT):
        deferral, _ = _deferral(data, year)
        premiums = data.health_premium_per_paycheck_cents * data.pay_periods_per_year
        return Decimal(data.salary_cents) - deferral - premiums


@dataclass(frozen=True)
class _Withholding:
    adjusted_annual_wage: Decimal
    row: WithholdingRow
    per_paycheck_cents: int


class _Form:
    """Rules 3 to 6 for one set of Step 4(b) and 4(c) entries; everything else fixed."""

    def __init__(self, data: W4Input, tables: Pub15T, wages: Decimal) -> None:
        self.periods = data.pay_periods_per_year
        self.credits = Decimal(data.dependents_credit_cents)
        self.other_income = data.other_income_cents
        self.wages = wages
        status = data.filing_status
        if data.multiple_jobs:
            self.schedule: Schedule = "step2_checkbox"
            self.rows = tables.step2_checkbox[status]
            self.line_1g = 0
        else:
            self.schedule = "standard"
            self.rows = tables.standard[status]
            self.line_1g = tables.worksheet_1g_cents[status]

    def adjusted_annual_wage(self, deductions: int) -> Decimal:
        """Rule 3: Worksheet 1A line 1i."""
        return max(_ZERO, self.wages + self.other_income - (deductions + self.line_1g))

    def withholding(self, deductions: int, extra: int) -> _Withholding:
        aaw = self.adjusted_annual_wage(deductions)
        row = self.rows[0]
        for candidate in self.rows:
            if candidate.at_least_cents <= aaw:
                row = candidate
        tentative = row.base_cents + row.rate_pct / _HUNDRED * (aaw - row.at_least_cents)
        line_3c = max(_ZERO, tentative / self.periods - self.credits / self.periods)
        return _Withholding(aaw, row, round_half_up(line_3c + extra))

    def annual(self, deductions: int, extra: int) -> int:
        """Rule 6: what the paychecks withhold in the year."""
        return self.withholding(deductions, extra).per_paycheck_cents * self.periods


def _nearest_extra(refund: int, extra: int, periods: int) -> int:
    """Rule 12: the whole-dollar Step 4(c) entry, in cents, that brings
    ``refund + (entry - extra) * periods`` closest to zero (ties to the refund)."""
    target = (Decimal(extra) - Decimal(refund) / periods) / _HUNDRED
    candidates = {
        max(0, int(target.to_integral_value(rounding))) * 100
        for rounding in (ROUND_FLOOR, ROUND_CEILING)
    }

    def after(entry: int) -> int:
        return refund + (entry - extra) * periods

    return min(candidates, key=lambda entry: (abs(after(entry)), -after(entry)))


def _added_deductions(form: _Form, deductions: int, extra: int, other: int) -> int:
    """Rule 13: whole dollars to add to Step 4(b), by binary search on the
    non-increasing refund ``other + annual(deductions + 100 * d)``."""

    def refund(dollars: int) -> int:
        return other + form.annual(deductions + 100 * dollars, extra)

    reach = form.adjusted_annual_wage(deductions)
    high = int((reach / _HUNDRED).to_integral_value(ROUND_CEILING))
    floor = max(0, refund(high))
    low = 0
    while low < high:
        middle = (low + high) // 2
        if refund(middle) <= floor:
            high = middle
        else:
            low = middle + 1
    if low > 0 and refund(low) < 0 and abs(refund(low - 1)) <= abs(refund(low)):
        low -= 1
    return low


def _citation_keys(data: W4Input, deferral: Decimal) -> list[str]:
    keys = list(BASE_CITATION_KEYS)
    if data.multiple_jobs or data.other_jobs_wages_cents > 0:
        keys.append(MULTIPLE_JOBS_KEY)
    if data.dependents_credit_cents > 0:
        keys.append(DEPENDENTS_CREDIT_KEY)
    if deferral > 0:
        keys.append(PRETAX_DEFERRAL_KEY)
    return keys


def w4(data: W4Input) -> W4Result:
    year = tax_year(data.tax_year)
    with localcontext(CONTEXT):
        deferral, capped = _deferral(data, year)
        wages = _taxable_wages(data, year)
        periods = data.pay_periods_per_year
        form = _Form(data, pub15t(data.tax_year), wages)
        current = form.withholding(data.deductions_cents, data.extra_withholding_cents)
        annual = current.per_paycheck_cents * periods

        # Rules 7 to 10: the projection.
        expected = (
            data.expected_deductions_cents
            if data.expected_deductions_cents is not None
            else data.deductions_cents
        )
        taxable_income = max(
            _ZERO,
            wages
            + data.other_jobs_wages_cents
            + data.other_income_cents
            - year.standard_deduction.cents[data.filing_status]
            - expected,
        )
        tax = income_tax(year, data.filing_status, taxable_income)
        tax_after_credits = round_half_up(max(_ZERO, tax - data.dependents_credit_cents))
        # The refund apart from this job's withholding.
        other = data.other_jobs_withholding_cents - tax_after_credits
        refund = annual + other

        # Rule 10a: the same tax, at what the newest stub withholds each paycheck.
        current_annual: int | None = None
        current_refund: int | None = None
        if data.current_withholding_per_paycheck_cents is not None:
            at_stub = _at(data.current_withholding_per_paycheck_cents, periods, other)
            current_annual = at_stub.annual_withholding_cents
            current_refund = at_stub.refund_cents

        # Rules 11 to 14: the suggestion.
        extra = data.extra_withholding_cents
        added = 0
        if abs(refund) > TARGET_CENTS and (refund < 0 or extra > 0):
            extra = _nearest_extra(refund, extra, periods)
        if refund - (data.extra_withholding_cents - extra) * periods > TARGET_CENTS:
            # Still a refund over $100: by now Step 4(c) is 0.
            added = _added_deductions(form, data.deductions_cents, extra, other)
        suggested_deductions = data.deductions_cents + 100 * added
        suggested_refund = other + form.annual(suggested_deductions, extra)
        suggestion: Suggestion = "none"
        if added > 0:
            suggestion = "increase_deductions"
        elif extra > data.extra_withholding_cents:
            suggestion = "increase_extra_withholding"
        elif extra < data.extra_withholding_cents:
            suggestion = "decrease_extra_withholding"

        return W4Result(
            k401_annual_cents=round_half_up(deferral),
            k401_capped=capped,
            health_premium_annual_cents=data.health_premium_per_paycheck_cents * periods,
            taxable_wages_per_paycheck_cents=round_half_up(wages / periods),
            adjusted_annual_wage_cents=round_half_up(current.adjusted_annual_wage),
            withholding_schedule=form.schedule,
            withholding_rate_pct=current.row.rate_pct,
            withholding_per_paycheck_cents=current.per_paycheck_cents,
            annual_withholding_cents=annual,
            projected_taxable_income_cents=round_half_up(taxable_income),
            projected_tax_cents=round_half_up(tax),
            projected_tax_after_credits_cents=tax_after_credits,
            projected_refund_cents=refund,
            current_annual_withholding_cents=current_annual,
            current_refund_cents=current_refund,
            suggestion=suggestion,
            suggested_extra_withholding_cents=extra,
            suggested_deductions_cents=suggested_deductions,
            suggested_refund_cents=suggested_refund,
            citation_keys=_citation_keys(data, deferral),
        )
