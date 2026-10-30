"""The 401(k) match calculator (spec 006).

``k401_match(K401MatchInput) -> K401MatchResult`` is pure: no I/O beyond the
committed tax-year constants, no clock, no randomness. Notation follows the
spec: ``S`` salary, ``c`` contribution percentage, ``F`` full-match
percentage, ``P`` pay periods, ``L`` deferral limit. Every intermediate value
is an exact ``Decimal``; each output is rounded once, half up, to whole cents.
"""

from __future__ import annotations

from collections.abc import Sequence
from decimal import Decimal, localcontext
from itertools import pairwise
from typing import Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from calc.brackets import marginal_rate
from calc.data import FilingStatus, K401Limits, UnknownTaxYear, tax_year
from calc.money import CONTEXT, pct_of, per_period, round_half_up
from calc.types import (
    Cents,
    PayPeriods,
    Percent,
    PositiveCents,
    PositivePercent,
    ResultPercent,
)

__all__ = [
    "BASE_CITATION_KEYS",
    "CATCH_UP_KEY",
    "COMPENSATION_LIMIT_KEY",
    "MAX_TIERS",
    "K401MatchInput",
    "K401MatchResult",
    "MatchTier",
    "PayPeriods",
    "cumulative_bounds",
    "deferral_limit_cents",
    "k401_match",
    "tiers_ascending",
    "tiers_from_bands",
]

MAX_TIERS = 5

# Spec 006 rule 11, in this order.
BASE_CITATION_KEYS = (
    "k401.employer_match",
    "k401.pretax_deferral",
    "k401.deferral_limit",
    "k401.federal_brackets",
)
CATCH_UP_KEY = "k401.catch_up"
COMPENSATION_LIMIT_KEY = "k401.compensation_limit"

_ZERO = Decimal(0)
_HUNDRED = Decimal(100)


class MatchTier(BaseModel):
    """The employer puts in ``employer_pct`` of each dollar the employee
    contributes, up to ``employee_pct_upto`` percent of pay (spec 006)."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    employee_pct_upto: PositivePercent
    employer_pct: PositivePercent


def tiers_ascending(tiers: Sequence[MatchTier]) -> None:
    """Tiers are cumulative: each bound must be above the one before it."""
    uptos = [tier.employee_pct_upto for tier in tiers]
    if any(later <= earlier for earlier, later in pairwise(uptos)):
        raise ValueError(
            "Each match tier must reach a higher contribution rate than the one before it"
        )


def cumulative_bounds(bands: Sequence[Decimal]) -> list[Decimal]:
    """Each tier's upper bound: its band plus every band before it (spec 013 rule 8).
    Exact ``Decimal`` sums; a band must be positive."""
    bounds: list[Decimal] = []
    upto = _ZERO
    for band in bands:
        if band <= 0:
            raise ValueError(f"a match band must be positive, not {band}")
        upto += band
        bounds.append(upto)
    return bounds


def tiers_from_bands(bands: Sequence[tuple[Decimal, Decimal]]) -> list[MatchTier]:
    """``(band, share)`` pairs as a summary prints them ("100% of the first 3%,
    50% of the next 2%") become cumulative tiers (3@100, 5@50). Raises
    ``ValueError`` when the result is not a valid formula."""
    bounds = cumulative_bounds([band for band, _ in bands])
    return [
        MatchTier(employee_pct_upto=upto, employer_pct=share)
        for upto, (_, share) in zip(bounds, bands, strict=True)
    ]


class K401MatchInput(BaseModel):
    """The calculator's inputs, exactly as spec 006 lists them."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    salary_cents: PositiveCents = Field(description="Annual base salary in cents")
    pay_periods_per_year: PayPeriods
    match_tiers: list[MatchTier] = Field(
        max_length=MAX_TIERS,
        description="The employer formula; cumulative bounds in percent of salary, ascending",
    )
    contribution_pct: Percent = Field(description="Pre-tax deferral rate in percent of salary")
    tax_year: int = Field(strict=True, description="The pay stub's tax year")
    filing_status: FilingStatus
    age: int = Field(
        strict=True, ge=0, le=130, description="Age reached by December 31 of tax_year"
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
    def _tiers_ascending(self) -> Self:
        tiers_ascending(self.match_tiers)
        return self


class K401MatchResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    full_match_pct: ResultPercent = Field(
        description="Lowest contribution percentage that earns the whole match"
    )
    employer_match_cents_current: Cents
    employer_match_cents_full: Cents
    missed_cents: Cents
    employee_annual_cents_current: Cents
    employee_annual_cents_full: Cents
    per_paycheck_cost_delta_cents: Cents
    per_paycheck_after_tax_cost_cents: Cents
    marginal_rate_used: ResultPercent = Field(
        description="Federal bracket rate, in percent points, at the current contribution"
    )
    deferral_limit_cents: Cents
    capped: bool
    compensation_capped: bool
    citation_keys: list[str]


def deferral_limit_cents(limits: K401Limits, age: int) -> int:
    """402(g) limit plus the catch-up for ``age`` (spec 006 rule 1)."""
    if 60 <= age <= 63:
        catch_up = limits.catch_up_60_63_cents
    elif age >= 50:
        catch_up = limits.catch_up_50_cents
    else:
        catch_up = 0
    return limits.elective_deferral_limit_cents + catch_up


def _match(tiers: Sequence[MatchTier], match_base: Decimal, deferral: Decimal) -> Decimal:
    """``M(E)`` of rule 5: each tier matches its share of the deferral."""
    total = _ZERO
    lower = _ZERO
    for tier in tiers:
        upper = pct_of(match_base, tier.employee_pct_upto)
        portion = max(_ZERO, min(deferral, upper) - lower)
        total += portion * tier.employer_pct / _HUNDRED
        lower = upper
    return total


def k401_match(data: K401MatchInput) -> K401MatchResult:
    year = tax_year(data.tax_year)
    with localcontext(CONTEXT):
        salary = Decimal(data.salary_cents)
        limit = deferral_limit_cents(year.k401, data.age)
        full_pct = max((tier.employee_pct_upto for tier in data.match_tiers), default=_ZERO)

        requested = pct_of(salary, data.contribution_pct)
        capped = requested > limit
        current = min(requested, Decimal(limit))
        full = min(pct_of(salary, full_pct), Decimal(limit))

        compensation_limit = year.k401.compensation_limit_cents
        compensation_capped = data.salary_cents > compensation_limit
        match_base = min(salary, Decimal(compensation_limit))
        match_current = round_half_up(_match(data.match_tiers, match_base, current))
        match_full = round_half_up(_match(data.match_tiers, match_base, full))

        delta = max(_ZERO, full - current)
        taxable = salary - current - year.standard_deduction.cents[data.filing_status]
        rate = marginal_rate(year, data.filing_status, taxable)
        periods = data.pay_periods_per_year
        after_tax = per_period(delta * (1 - rate / _HUNDRED), periods)

        keys = list(BASE_CITATION_KEYS)
        if data.age >= 50:
            keys.append(CATCH_UP_KEY)
        if compensation_capped:
            keys.append(COMPENSATION_LIMIT_KEY)

        return K401MatchResult(
            full_match_pct=full_pct,
            employer_match_cents_current=match_current,
            employer_match_cents_full=match_full,
            missed_cents=match_full - match_current,
            employee_annual_cents_current=round_half_up(current),
            employee_annual_cents_full=round_half_up(full),
            per_paycheck_cost_delta_cents=round_half_up(per_period(delta, periods)),
            per_paycheck_after_tax_cost_cents=round_half_up(after_tax),
            marginal_rate_used=rate,
            deferral_limit_cents=limit,
            capped=capped,
            compensation_capped=compensation_capped,
            citation_keys=keys,
        )
