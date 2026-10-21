"""Structured-output schemas. The gateway sends each as the response's JSON schema
and validates the model's reply against it; a prompt file names its schema by
class name (``SCHEMAS``).

Model output is a proposal: confidences here are self-reported and only decide
what the UI marks "needs review" (technical spec, amendment 12).
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from sync.categories import CATEGORIES, Category

__all__ = [
    "CATEGORIES",
    "SCHEMAS",
    "CategoryAssignment",
    "CategoryBatch",
    "ExplanationDraft",
    "ExtractedField",
    "PayStubExtraction",
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


class ExtractedField(_Strict):
    """One value read from a document, exactly as printed (parsed later in code)."""

    value: str | None = Field(description="The value as printed, or null when absent")
    confidence: float = Field(ge=0, le=1)


class PayStubExtraction(_Strict):
    """``extract`` output for a pay stub (M2, spec 005). Amounts are this period's."""

    employer_name: ExtractedField
    pay_date: ExtractedField
    period_start: ExtractedField
    period_end: ExtractedField
    gross: ExtractedField
    federal_withholding: ExtractedField
    social_security: ExtractedField
    medicare: ExtractedField
    state_tax: ExtractedField
    retirement_contribution: ExtractedField
    medical_premium: ExtractedField
    net: ExtractedField


class ExplanationDraft(_Strict):
    """``explain`` output (M4, spec 007). The verifier checks every number and
    citation key against the calculator result before anything is shown."""

    concept: str
    body: str
    numbers: list[str] = Field(description="Every number in body, verbatim")
    citation_keys: list[str]
    what_ifs: list[str]


SCHEMAS: dict[str, type[BaseModel]] = {
    "CategoryBatch": CategoryBatch,
    "PayStubExtraction": PayStubExtraction,
    "ExplanationDraft": ExplanationDraft,
}
