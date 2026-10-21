"""Structured-output schemas. The gateway sends each as the response's JSON schema
and validates the model's reply against it; a prompt file names its schema by
class name (``SCHEMAS``).

Model output is a proposal: confidences here are self-reported and only decide
what the UI marks "needs review" (technical spec, amendment 12). Nothing here
is ever written to a confirmed table; the user's confirmed values are
validated separately (``ingest/proposal.py``).
"""

from __future__ import annotations

import datetime as dt
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from sync.categories import CATEGORIES, Category

__all__ = [
    "CATEGORIES",
    "SCHEMAS",
    "BenefitsExtraction",
    "CategoryAssignment",
    "CategoryBatch",
    "Cents",
    "DateField",
    "ExplanationDraft",
    "ExtractedField",
    "LineItem",
    "LineItemKind",
    "MoneyField",
    "NumberClaim",
    "PayFrequencyField",
    "PayFrequencyValue",
    "PayStubExtraction",
    "PayStubMoneyField",
    "PercentField",
    "PlanExtraction",
    "PlanKindField",
    "PlanKindValue",
    "TextField",
]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CategoryAssignment(_Strict):
    id: int = Field(ge=1, le=50, description="The item's id from the request")
    category: Category
    confidence: float = Field(ge=0, le=1, description="How sure the label is, 0 to 1")


class CategoryBatch(_Strict):
    """``categorize`` output: one assignment per merchant the model could label."""

    items: list[CategoryAssignment]


# ---------------------------------------------------------------- extraction (spec 005)

# Integer cents, never negative: whether a line adds or subtracts is carried by
# the field (spec 001 rule 23). Strict, so 2708.0 or "2,708.33" never pass.
Cents = Annotated[int, Field(strict=True, ge=0)]
Percent = Annotated[float, Field(ge=0, le=100)]
PayFrequencyValue = Literal["weekly", "biweekly", "semimonthly", "monthly"]
PlanKindValue = Literal["hdhp", "ppo", "hmo"]
LineItemKind = Literal["earning", "tax", "pre_tax_deduction", "post_tax_deduction", "net", "info"]
PayStubMoneyField = Literal[
    "gross_cents",
    "federal_withholding_cents",
    "social_security_cents",
    "medicare_cents",
    "state_tax_cents",
    "retirement_contribution_cents",
    "medical_premium_cents",
    "net_cents",
]


class ExtractedField[T](_Strict):
    """One value read from a document (spec 005 rule 1)."""

    value: T | None = Field(description="The value, or null when the document does not show it")
    confidence: float = Field(ge=0, le=1, description="How sure the reading is, 0 to 1")
    source_text: str | None = Field(
        description="The printed line the value was read from, copied as it appears"
        " ([REDACTED] included), or null"
    )


# Named parametrizations, so the JSON schema's $defs read as words.
class TextField(ExtractedField[str]):
    """Text as printed."""


class DateField(ExtractedField[dt.date]):
    """A calendar date, written as YYYY-MM-DD whatever the document's format."""


class MoneyField(ExtractedField[Cents]):
    """An amount in integer cents: $2,708.33 is 270833."""


class PercentField(ExtractedField[Percent]):
    """A percentage from 0 to 100."""


class PayFrequencyField(ExtractedField[PayFrequencyValue]):
    """How often the employee is paid."""


class PlanKindField(ExtractedField[PlanKindValue]):
    """The plan type: hdhp (high-deductible, HSA-eligible), ppo or hmo."""


class LineItem(_Strict):
    """One printed line of the stub's current-period column (spec 005 rule 3)."""

    label: str = Field(description="The line's label as printed")
    amount_cents: Cents = Field(description="This period's amount in cents, never negative")
    kind: LineItemKind
    field: PayStubMoneyField | None = Field(
        description="The field above this line is already counted in, or null when it has"
        " no field of its own"
    )


class PayStubExtraction(_Strict):
    """``extract_pay_stub`` output. Amounts are this pay period's, not year to date."""

    employer_name: TextField
    pay_frequency: PayFrequencyField
    pay_date: DateField
    period_start: DateField
    period_end: DateField
    gross_cents: MoneyField
    federal_withholding_cents: MoneyField
    social_security_cents: MoneyField
    medicare_cents: MoneyField
    state_tax_cents: MoneyField
    retirement_contribution_cents: MoneyField
    medical_premium_cents: MoneyField
    net_cents: MoneyField
    line_items: list[LineItem]
    notes: str | None = Field(description="Anything the reviewer should check, or null")


class PlanExtraction(_Strict):
    """One health plan option from a benefits summary (spec 005 rule 4)."""

    name: TextField
    kind: PlanKindField
    premium_per_period_cents: MoneyField
    deductible_cents: MoneyField
    oop_max_cents: MoneyField
    coinsurance_pct: PercentField
    employer_hsa_cents: MoneyField
    enrollment_deadline: DateField


class BenefitsExtraction(_Strict):
    """``extract_benefits`` output: every medical plan option the summary describes."""

    plans: list[PlanExtraction]
    notes: str | None = Field(description="Anything the reviewer should check, or null")


class NumberClaim(_Strict):
    """A figure the explanation states, for the UI to show beside the text."""

    value: str = Field(description="The number exactly as written in the text, e.g. $2,400.00")
    label: str = Field(description="What the number is, in a few words")


class ExplanationDraft(_Strict):
    """``explain`` output (spec 008 rule 9). Nothing here is shown until
    ``verify/verify.py`` has checked every number and citation key."""

    concept: str = Field(description="One sentence naming the idea behind the decision")
    text: str = Field(description="Two to five short paragraphs explaining the decision")
    numbers: list[NumberClaim] = Field(description="The key figures the text states")
    what_ifs: list[str] = Field(
        max_length=3, description="Up to three short what-if sentences using only the facts"
    )
    citation_keys: list[str] = Field(description="Keys of the allowed citations the text relies on")


SCHEMAS: dict[str, type[BaseModel]] = {
    "CategoryBatch": CategoryBatch,
    "PayStubExtraction": PayStubExtraction,
    "BenefitsExtraction": BenefitsExtraction,
    "ExplanationDraft": ExplanationDraft,
}
