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
from typing import Annotated, Literal, Protocol, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from calc.pay_stub import PayStubAmounts, total_cents
from llm.schemas import (
    BenefitsExtraction,
    ExtractedField,
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
# A sanity bound well inside bigint: $1 billion. Larger is a typo, not a stub.
MAX_CENTS = 100_000_000_000

FieldKind = Literal["money", "date", "text", "percent"]
FieldRole = Literal["gross", "deduction", "net", "info"]
FieldValue = int | str | None

__all__ = [
    "MAX_CENTS",
    "PAY_STUB_FIELDS",
    "PLAN_FIELDS",
    "BenefitsValues",
    "FieldSpec",
    "PageLines",
    "PayStubValues",
    "PlanProposal",
    "PlanValues",
    "Proposal",
    "ProposedField",
    "SourceLine",
    "SourcePage",
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


class Proposal(_Model):
    """``documents.proposal`` (spec 005 outputs)."""

    fields: list[ProposedField] = Field(default_factory=list)
    line_items: list[LineItem] = Field(default_factory=list)
    plans: list[PlanProposal] = Field(default_factory=list)
    source_lines: list[SourceLine] = Field(default_factory=list)
    withheld_pages: list[int] = Field(default_factory=list)
    notes: str | None = None


class PageLines(Protocol):
    """A page's redacted lines; ``ingest.pipeline.PreparedPage`` is one."""

    @property
    def number(self) -> int: ...

    @property
    def lines(self) -> Sequence[str]: ...


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
        extracted: ExtractedField[object] = getattr(extraction, spec.key)
        fields.append(_proposed(spec, extracted))
        sources[spec.key] = extracted.source_text
    return Proposal(
        fields=fields,
        line_items=extraction.line_items,
        source_lines=_link(_source_lines(pages), fields, sources),
        withheld_pages=list(withheld_pages),
        notes=extraction.notes,
    )


def benefits_proposal(
    extraction: BenefitsExtraction, pages: Sequence[PageLines], withheld_pages: Sequence[int]
) -> Proposal:
    return Proposal(
        plans=[_plan(plan) for plan in extraction.plans],
        source_lines=_source_lines(pages),
        withheld_pages=list(withheld_pages),
        notes=extraction.notes,
    )


def manual_entry_proposal(
    document_type: str, pages: Sequence[PageLines], withheld_pages: Sequence[int]
) -> Proposal:
    """Rule 12: the redacted lines to type from, and nothing filled in."""
    if document_type == "pay_stub":
        fields = [_empty(spec) for spec in PAY_STUB_FIELDS]
    elif document_type == "benefits":
        fields = []
    else:
        raise ValueError(f"no proposal for document type {document_type!r}")
    return Proposal(
        fields=fields, source_lines=_source_lines(pages), withheld_pages=list(withheld_pages)
    )


def benefits_text(proposal: Proposal) -> str:
    """The redacted text that benefits chunks are cut from (rule 22)."""
    return "\n".join(line.text for line in proposal.source_lines)


def _proposed(spec: FieldSpec, extracted: ExtractedField[object]) -> ProposedField:
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
    if kind == "percent" and isinstance(value, int | float):
        return str(Decimal(str(value)).quantize(Decimal("0.01")))
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

Cents = Annotated[int, Field(strict=True, ge=0, le=MAX_CENTS)]
PositiveCents = Annotated[int, Field(strict=True, gt=0, le=MAX_CENTS)]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
ConfirmedPercent = Annotated[Decimal, Field(ge=0, le=100, max_digits=5, decimal_places=2)]


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
    coinsurance_pct: ConfirmedPercent
    employer_hsa_cents: Cents
    enrollment_deadline: dt.date | None

    @model_validator(mode="after")
    def _deductible_within_oop_max(self) -> Self:
        if self.deductible_cents > self.oop_max_cents:
            raise ValueError("deductible_cents must not exceed oop_max_cents")
        return self


class BenefitsValues(BaseModel):
    model_config = ConfigDict(extra="forbid")

    plans: list[PlanValues] = Field(min_length=1, max_length=20)
