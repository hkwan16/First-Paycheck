"""Yearly federal constants: ``calc/data/<year>.json`` (spec amendment 13).

Each file holds one tax year's retirement limits, HSA limits, standard deductions and
income tax brackets, each group with the IRS document it comes from. A
calculator receives ``tax_year`` explicitly and reads its constants through
``tax_year(year)``; a year with no file is an ``UnknownTaxYear``, never a silent
fallback to another year. The files are committed reference data, read once
and cached, so calculators stay deterministic.
"""

from __future__ import annotations

from decimal import Decimal
from functools import cache
from pathlib import Path
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

__all__ = [
    "FILING_STATUSES",
    "Bracket",
    "Brackets",
    "FilingStatus",
    "HsaLimits",
    "K401Limits",
    "StandardDeduction",
    "TaxYearData",
    "UnknownTaxYear",
    "available_years",
    "tax_year",
]

DATA_DIR = Path(__file__).resolve().parent

FilingStatus = Literal["single", "married_filing_jointly", "head_of_household"]
FILING_STATUSES: tuple[FilingStatus, ...] = (
    "single",
    "married_filing_jointly",
    "head_of_household",
)

_Cents = Annotated[int, Field(strict=True, ge=0)]


class UnknownTaxYear(ValueError):
    """No constants file exists for the requested tax year."""


class _Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class K401Limits(_Frozen):
    elective_deferral_limit_cents: _Cents
    catch_up_50_cents: _Cents
    catch_up_60_63_cents: _Cents
    compensation_limit_cents: _Cents
    source: str
    url: str


class HsaLimits(_Frozen):
    """HSA contribution limits and the high deductible health plan thresholds (spec 012)."""

    self_only_limit_cents: _Cents
    family_limit_cents: _Cents
    hdhp_min_deductible_self_cents: _Cents
    hdhp_min_deductible_family_cents: _Cents
    hdhp_max_oop_self_cents: _Cents
    hdhp_max_oop_family_cents: _Cents
    source: str
    url: str


class StandardDeduction(_Frozen):
    cents: dict[FilingStatus, _Cents]
    source: str
    url: str

    @model_validator(mode="after")
    def _every_status(self) -> Self:
        if set(self.cents) != set(FILING_STATUSES):
            raise ValueError("standard_deduction needs exactly one amount per filing status")
        return self


class Bracket(_Frozen):
    """Income up to ``up_to_cents`` (inclusive, "not over") is taxed at ``rate_pct``;
    ``None`` marks the top bracket."""

    rate_pct: Decimal = Field(ge=0, le=100)
    up_to_cents: _Cents | None


class Brackets(_Frozen):
    by_status: dict[FilingStatus, tuple[Bracket, ...]]
    source: str
    url: str

    @model_validator(mode="after")
    def _well_formed(self) -> Self:
        if set(self.by_status) != set(FILING_STATUSES):
            raise ValueError("brackets need exactly one table per filing status")
        for status, table in self.by_status.items():
            bounds = [bracket.up_to_cents for bracket in table]
            if not bounds or bounds[-1] is not None or None in bounds[:-1]:
                raise ValueError(f"{status}: only the last bracket may be open-ended")
            finite = [bound for bound in bounds if bound is not None]
            if finite != sorted(set(finite)):
                raise ValueError(f"{status}: bracket bounds must strictly increase")
        return self


class TaxYearData(_Frozen):
    tax_year: int
    k401: K401Limits
    hsa: HsaLimits
    standard_deduction: StandardDeduction
    brackets: Brackets


def _path(year: int) -> Path:
    return DATA_DIR / f"{year}.json"


def available_years() -> frozenset[int]:
    """Every tax year with a constants file."""
    return frozenset(int(path.stem) for path in DATA_DIR.glob("*.json") if path.stem.isdigit())


@cache
def tax_year(year: int) -> TaxYearData:
    path = _path(year)
    if not path.is_file():
        raise UnknownTaxYear(f"no federal constants for tax year {year}")
    data = TaxYearData.model_validate_json(path.read_text(encoding="utf-8"))
    if data.tax_year != year:
        raise UnknownTaxYear(f"{path.name} declares tax year {data.tax_year}, not {year}")
    return data
