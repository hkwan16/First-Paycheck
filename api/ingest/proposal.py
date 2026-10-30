"""From a model answer to reviewable fields, and the values a user confirms
(spec 005 rules 3, 16-20). API-safe: no OCR, PDF or model imports.

The model's answer is only ever a proposal. ``pay_stub_proposal`` and
``benefits_proposal`` turn it into the ``documents.proposal`` the review screen
shows; ``PayStubValues`` and ``PlanValues`` validate what the user sends back,
and only those values are stored.
"""

from __future__ import annotations

import datetime as dt
import re
from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal
from typing import Annotated, Any, Literal, Protocol, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from calc.health_plans import DEDUCTIBLE_OVER_OOP, HSA_WITHOUT_HDHP
from calc.k401 import MAX_TIERS, MatchTier, cumulative_bounds, tiers_ascending
from calc.pay_stub import PayStubAmounts, total_cents
from calc.types import Cents, Percent, PositiveCents
from llm.schemas import (
    BenefitsSummaryExtraction,
    LineItem,
    PayFrequencyValue,
    PayStubExtraction,
    PlanExtraction,
    PlanKindValue,
)

REDACTED_MARK = "[REDACTED]"
NOT_FOUND = "Not found on the document"
NO_OTHER_DEDUCTIONS = "No other deductions listed"
OTHER_DEDUCTIONS = "other_deductions_cents"
DEDUCTION_KINDS = frozenset({"tax", "pre_tax_deduction", "post_tax_deduction"})

FieldKind = Literal["money", "date", "text", "percent", "number"]
ProposalKind = Literal["pay_stub", "benefits"]
FieldRole = Literal["gross", "deduction", "net", "info"]
FieldValue = int | str | None

__all__ = [
    "PAY_STUB_FIELDS",
    "PLAN_FIELDS",
    "BenefitsValues",
    "FieldSpec",
    "PageLines",
    "PayStubValues",
    "PlanProposal",
    "PlanValues",
    "Proposal",
    "ProposalKind",
    "ProposedField",
    "RetirementValues",
    "SourceLine",
    "SourcePage",
    "TierProposal",
    "benefits_proposal",
    "benefits_text",
    "manual_entry_proposal",
    "pay_stub_proposal",
]


@dataclass(frozen=True)
class FieldSpec:
    key: str
    label: str
    kind: FieldKind
    role: FieldRole = "info"


# Rule 16: the review order. other_deductions_cents is computed, not extracted.
PAY_STUB_FIELDS: tuple[FieldSpec, ...] = (
    FieldSpec("employer_name", "Employer", "text"),
    FieldSpec("pay_date", "Pay date", "date"),
    FieldSpec("period_start", "Period start", "date"),
    FieldSpec("period_end", "Period end", "date"),
    FieldSpec("pay_frequency", "Pay frequency", "text"),
    FieldSpec("gross_cents", "Gross pay", "money", "gross"),
    FieldSpec("federal_withholding_cents", "Federal income tax", "money", "deduction"),
    FieldSpec("social_security_cents", "Social Security", "money", "deduction"),
    FieldSpec("medicare_cents", "Medicare", "money", "deduction"),
    FieldSpec("state_tax_cents", "State income tax", "money", "deduction"),
    FieldSpec("retirement_contribution_cents", "401(k) contribution", "money", "deduction"),
    FieldSpec("medical_premium_cents", "Medical premium", "money", "deduction"),
    FieldSpec(OTHER_DEDUCTIONS, "Other deductions", "money", "deduction"),
    FieldSpec("net_cents", "Net pay", "money", "net"),
)

PLAN_FIELDS: tuple[FieldSpec, ...] = (
    FieldSpec("name", "Plan name", "text"),
    FieldSpec("kind", "Plan type", "text"),
    FieldSpec("premium_per_period_cents", "Premium per paycheck", "money"),
    FieldSpec("deductible_cents", "Deductible", "money"),
    FieldSpec("oop_max_cents", "Out-of-pocket maximum", "money"),
    FieldSpec("coinsurance_pct", "Coinsurance", "percent"),
    FieldSpec("employer_hsa_cents", "Employer HSA contribution", "money"),
    FieldSpec("enrollment_deadline", "Enrollment deadline", "date"),
)
TIER_BOUND = FieldSpec("employee_pct_upto", "Matched up to (% of pay)", "percent")
TIER_SHARE = FieldSpec("employer_pct", "Employer match", "percent")
VESTING = FieldSpec("vesting_years", "Years to full vesting", "number")
_HUNDREDTH = Decimal("0.01")


# ---------------------------------------------------------------- proposal


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ProposedField(_Model):
    key: str
    label: str
    # Integer cents for money, an ISO date string, a percent with two places
    # as a string ("10.00"), or text.
    value: FieldValue
    # The model's self-reported confidence; null for computed or manual fields.
    confidence: float | None
    note: str | None
    kind: FieldKind
    role: FieldRole


class SourceLine(_Model):
    page: int
    text: str
    field_key: str | None
    redacted: bool


class PlanProposal(_Model):
    fields: list[ProposedField]


class TierProposal(_Model):
    """One 401(k) match tier: ``employee_pct_upto`` (computed) and ``employer_pct``."""

    fields: list[ProposedField]


class Proposal(_Model):
    """``documents.proposal`` (spec 005 outputs, spec 013 rules 7-9)."""

    kind: ProposalKind
    fields: list[ProposedField] = Field(default_factory=list)
    line_items: list[LineItem] = Field(default_factory=list)
    plans: list[PlanProposal] = Field(default_factory=list)
    match_tiers: list[TierProposal] = Field(default_factory=list)
    vesting_years: ProposedField | None = None
    source_lines: list[SourceLine] = Field(default_factory=list)
    withheld_pages: list[int] = Field(default_factory=list)
    notes: str | None = None

    @classmethod
    def stored(cls, data: dict[str, Any], document_type: str) -> Proposal:
        """A stored proposal; one saved before M6 has no ``kind``, so the
        document's type fills it."""
        return cls.model_validate({"kind": document_type, **data})


class PageLines(Protocol):
    """A page's redacted lines; ``ingest.pipeline.PreparedPage`` is one."""

    @property
    def number(self) -> int: ...

    @property
    def lines(self) -> Sequence[str]: ...


class Reading(Protocol):
    """One value the model read; every ``llm.schemas.ExtractedField`` is one."""

    @property
    def value(self) -> object: ...

    @property
    def confidence(self) -> float: ...

    @property
    def source_text(self) -> str | None: ...


@dataclass(frozen=True)
class SourcePage:
    number: int
    lines: Sequence[str]


def pay_stub_proposal(
    extraction: PayStubExtraction, pages: Sequence[PageLines], withheld_pages: Sequence[int]
) -> Proposal:
    fields: list[ProposedField] = []
    sources: dict[str, str | None] = {}
    for spec in PAY_STUB_FIELDS:
        if spec.key == OTHER_DEDUCTIONS:
            fields.append(_other_deductions(spec, extraction.line_items))
            continue
        extracted: Reading = getattr(extraction, spec.key)
        fields.append(_proposed(spec, extracted))
        sources[spec.key] = extracted.source_text
    return Proposal(
        kind="pay_stub",
        fields=fields,
        line_items=extraction.line_items,
        source_lines=_link(_source_lines(pages), fields, sources),
        withheld_pages=list(withheld_pages),
        notes=extraction.notes,
    )


def benefits_proposal(
    extraction: BenefitsSummaryExtraction,
    pages: Sequence[PageLines],
    withheld_pages: Sequence[int],
) -> Proposal:
    return Proposal(
        kind="benefits",
        plans=[_plan(plan) for plan in extraction.plans],
        match_tiers=_tiers(extraction),
        vesting_years=_proposed(VESTING, extraction.vesting_years),
        source_lines=_source_lines(pages),
        withheld_pages=list(withheld_pages),
        notes=extraction.notes,
    )


def manual_entry_proposal(
    document_type: str, pages: Sequence[PageLines], withheld_pages: Sequence[int]
) -> Proposal:
    """Rule 12: the redacted lines to type from, and nothing filled in."""
    if document_type == "pay_stub":
        return Proposal(
            kind="pay_stub",
            fields=[_empty(spec) for spec in PAY_STUB_FIELDS],
            source_lines=_source_lines(pages),
            withheld_pages=list(withheld_pages),
        )
    if document_type == "benefits":
        return Proposal(
            kind="benefits",
            vesting_years=_empty(VESTING),
            source_lines=_source_lines(pages),
            withheld_pages=list(withheld_pages),
        )
    raise ValueError(f"no proposal for document type {document_type!r}")


def benefits_text(proposal: Proposal) -> str:
    """The redacted text that benefits chunks are cut from (rule 22)."""
    return "\n".join(line.text for line in proposal.source_lines)


def _proposed(spec: FieldSpec, extracted: Reading) -> ProposedField:
    value = _field_value(spec.kind, extracted.value)
    return ProposedField(
        key=spec.key,
        label=spec.label,
        value=value,
        confidence=extracted.confidence,
        note=NOT_FOUND if value is None else None,
        kind=spec.kind,
        role=spec.role,
    )


def _empty(spec: FieldSpec) -> ProposedField:
    return ProposedField(
        key=spec.key,
        label=spec.label,
        value=None,
        confidence=None,
        note=None,
        kind=spec.kind,
        role=spec.role,
    )


def _field_value(kind: FieldKind, value: object) -> FieldValue:
    if value is None:
        return None
    if isinstance(value, dt.date):
        return value.isoformat()
    if kind == "percent" and isinstance(value, int | float | Decimal):
        return str(Decimal(str(value)).quantize(_HUNDREDTH))
    if isinstance(value, int | str):
        return value
    raise TypeError(f"unexpected {kind} value {value!r}")


def _other_deductions(spec: FieldSpec, line_items: Sequence[LineItem]) -> ProposedField:
    """Rule 3: deduction lines with no column of their own, summed in code."""
    unassigned = [
        item for item in line_items if item.kind in DEDUCTION_KINDS and item.field is None
    ]
    note = (
        "Sum of: " + ", ".join(item.label for item in unassigned)
        if unassigned
        else NO_OTHER_DEDUCTIONS
    )
    return ProposedField(
        key=spec.key,
        label=spec.label,
        value=total_cents(item.amount_cents for item in unassigned),
        confidence=None,
        note=note,
        kind=spec.kind,
        role=spec.role,
    )


def _plan(plan: PlanExtraction) -> PlanProposal:
    return PlanProposal(fields=[_proposed(spec, getattr(plan, spec.key)) for spec in PLAN_FIELDS])


def _tiers(extraction: BenefitsSummaryExtraction) -> list[TierProposal]:
    """Spec 013 rule 8: the printed bands become cumulative bounds, in code."""
    tiers: list[TierProposal] = []
    bands: list[Decimal] = []
    confidence = 1.0
    complete = True
    for index, tier in enumerate(extraction.match_tiers):
        band = tier.band_pct.value
        if band is None or band <= 0:
            complete = False
        if complete and band is not None:
            band_pct = Decimal(str(band)).quantize(_HUNDREDTH)
            bands.append(band_pct)
            confidence = min(confidence, tier.band_pct.confidence)
            upto = cumulative_bounds(bands)[-1]
            bound = ProposedField(
                key=TIER_BOUND.key,
                label=TIER_BOUND.label,
                value=_field_value("percent", upto),
                confidence=confidence,
                note=f"Cumulative: {band_pct}% added to the tiers before it" if index else None,
                kind=TIER_BOUND.kind,
                role=TIER_BOUND.role,
            )
        else:
            bound = _empty(TIER_BOUND).model_copy(update={"note": NOT_FOUND})
        tiers.append(TierProposal(fields=[bound, _proposed(TIER_SHARE, tier.employer_pct)]))
    return tiers


def _source_lines(pages: Sequence[PageLines]) -> list[SourceLine]:
    return [
        SourceLine(page=page.number, text=text, field_key=None, redacted=REDACTED_MARK in text)
        for page in pages
        for text in page.lines
    ]


def _normalize(text: str) -> str:
    return " ".join(text.lower().split())


def _dollars_pattern(cents: int) -> re.Pattern[str]:
    printed = f"{cents // 100:,}.{cents % 100:02d}"
    # Standalone, so 0.00 does not match inside 10.00.
    return re.compile(rf"(?<![\d.,]){re.escape(printed)}(?!\d)")


def _link(
    lines: list[SourceLine], fields: Sequence[ProposedField], sources: dict[str, str | None]
) -> list[SourceLine]:
    """Rule 18: each field claims the first unclaimed line that quotes it."""
    normalized = [_normalize(line.text) for line in lines]
    claimed: dict[int, str] = {}

    def claim(key: str, pattern: re.Pattern[str]) -> bool:
        for index, text in enumerate(normalized):
            if index not in claimed and pattern.search(text):
                claimed[index] = key
                return True
        return False

    for field in fields:
        source = _normalize(sources.get(field.key) or "")
        if source and claim(field.key, re.compile(re.escape(source))):
            continue
        if field.kind == "money" and isinstance(field.value, int) and field.key in sources:
            claim(field.key, _dollars_pattern(field.value))
    return [
        line.model_copy(update={"field_key": claimed[index]}) if index in claimed else line
        for index, line in enumerate(lines)
    ]


# ---------------------------------------------------------------- confirmed values

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class PayStubValues(BaseModel):
    """What the user confirmed for a pay stub (rule 20): the extraction's keys
    with plain values, plus ``other_deductions_cents``."""

    model_config = ConfigDict(extra="forbid")

    employer_name: Name | None
    pay_frequency: PayFrequencyValue | None
    pay_date: dt.date
    period_start: dt.date
    period_end: dt.date
    gross_cents: PositiveCents
    federal_withholding_cents: Cents
    social_security_cents: Cents
    medicare_cents: Cents
    state_tax_cents: Cents
    retirement_contribution_cents: Cents
    medical_premium_cents: Cents
    other_deductions_cents: Cents
    net_cents: Cents

    @model_validator(mode="after")
    def _period_ordered(self) -> Self:
        if self.period_start > self.period_end:
            raise ValueError("period_start must be on or before period_end")
        return self

    def amounts(self) -> PayStubAmounts:
        return PayStubAmounts.model_validate(
            self.model_dump(include=set(PayStubAmounts.model_fields))
        )


class PlanValues(BaseModel):
    """One confirmed health plan (``benefits_plans`` row)."""

    model_config = ConfigDict(extra="forbid")

    name: Name
    kind: PlanKindValue
    premium_per_period_cents: Cents
    deductible_cents: Cents
    oop_max_cents: Cents
    coinsurance_pct: Percent
    employer_hsa_cents: Cents
    enrollment_deadline: dt.date | None

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if self.deductible_cents > self.oop_max_cents:
            raise ValueError(DEDUCTIBLE_OVER_OOP)
        if self.employer_hsa_cents > 0 and self.kind != "hdhp":
            # The health plan calculator's rule (spec 012 rule 12, spec 013 rule 11).
            raise ValueError(HSA_WITHOUT_HDHP)
        return self


class RetirementValues(BaseModel):
    """The confirmed 401(k) formula and vesting (spec 013 rule 10)."""

    model_config = ConfigDict(extra="forbid")

    match_tiers: list[MatchTier] = Field(max_length=MAX_TIERS)
    vesting_years: int | None = Field(default=None, ge=0, le=10, strict=True)

    @model_validator(mode="after")
    def _tiers_ascending(self) -> Self:
        tiers_ascending(self.match_tiers)
        return self


class BenefitsValues(BaseModel):
    model_config = ConfigDict(extra="forbid")

    plans: list[PlanValues] = Field(max_length=20)
    retirement: RetirementValues | None = None

    @model_validator(mode="after")
    def _something_to_store(self) -> Self:
        if not self.plans and self.retirement is None:
            raise ValueError("give at least one plan or the retirement part")
        return self
