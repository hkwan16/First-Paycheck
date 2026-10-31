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

from pydantic import BaseModel, ConfigDict, Field, model_validator

from sync.categories import CATEGORIES, Category

__all__ = [
    "CATEGORIES",
    "SCHEMAS",
    "BenefitsExtraction",
    "BenefitsSummaryExtraction",
    "CategoryAssignment",
    "CategoryBatch",
    "Cents",
    "ClaimDraft",
    "DateField",
    "ExplainCitation",
    "ExplainContext",
    "ExplainFact",
    "ExplanationDraft",
    "ExtractedField",
    "LineItem",
    "LineItemKind",
    "MatchTierExtraction",
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
    "RateClaimRequest",
    "RateClaimVerdict",
    "TextField",
    "WithholdingClaimRequest",
    "WithholdingClaimVerdict",
    "YearsField",
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
Years = Annotated[int, Field(strict=True, ge=0, le=10)]
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


class YearsField(ExtractedField[Years]):
    """A whole number of years from 0 to 10."""


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
    """``extract_benefits/v1`` output: every medical plan option the summary describes.

    Kept unchanged because the released v1 prompt names it; ``extract_benefits/v2``
    uses ``BenefitsSummaryExtraction`` (spec 013 rule 5)."""

    plans: list[PlanExtraction]
    notes: str | None = Field(description="Anything the reviewer should check, or null")


class MatchTierExtraction(_Strict):
    """One tier of the employer's 401(k) match as printed (spec 013 rule 2)."""

    band_pct: PercentField = Field(
        description="The tier's width in percent of pay, as printed: 'the next 2%' is 2"
    )
    employer_pct: PercentField = Field(
        description="The share of the employee's contribution the employer adds: '50%' is 50"
    )


class BenefitsSummaryExtraction(_Strict):
    """``extract_benefits/v2`` output: the medical plans, the 401(k) match and
    vesting (spec 013 rules 1-3)."""

    plans: list[PlanExtraction]
    match_tiers: list[MatchTierExtraction] = Field(
        description="The match tiers in the order the summary states them; empty for no match"
    )
    vesting_years: YearsField = Field(
        description="Years of service until the match is fully vested"
    )
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


class ExplainFact(_Strict):
    """One number the explanation may use, already formatted ("$2,400.00", "5%")."""

    label: str
    value: str


class ExplainCitation(_Strict):
    key: str
    title: str
    passage: str


class ExplainContext(_Strict):
    """What ``explain`` sends the model (spec 008 rule 7): the calculator's
    numbers, the curated passages it may cite and redacted benefits text."""

    calculator: str
    tax_year: int
    facts: list[ExplainFact]
    # Situations the explanation should mention (a deferral limit that binds).
    notes: list[str]
    citations: list[ExplainCitation]
    benefits_passages: list[str]


class ClaimDraft(_Strict):
    """The words of an explanation an eval judge reads: the rate-claim judge's
    (spec 008 rule 24a) and the withholding-claim judge's (rule 24d)."""

    concept: str
    text: str
    what_ifs: list[str]


class RateClaimRequest(_Strict):
    """What ``judge_rate_claim`` sends: the explain eval's question about one final
    row, with the rates formatted like the explain facts ("5%", "3.69%")."""

    chosen_rate: str
    # None: no confirmed pay stub, so what goes in now is not known.
    pay_stub_rate: str | None
    # None: the plan has no employer match.
    full_match_rate: str | None
    draft: ClaimDraft


class RateClaimVerdict(_Strict):
    """``judge_rate_claim`` output (spec 008 rule 24a): whether the draft says the
    rate chosen is the one in effect now, and the sentence that says so. It
    measures a draft in the eval and never gates one."""

    reason: str = Field(
        description=(
            "One or two sentences: which rate each present-tense sentence describes,"
            " worked out before the answer"
        )
    )
    claims_chosen_rate_in_effect: bool = Field(
        description="True when a sentence describes the rate chosen as the one in effect now"
    )
    sentence: str | None = Field(
        default=None,
        description="The first sentence that makes the claim, copied exactly; null when none does",
    )

    @model_validator(mode="after")
    def _sentence_exactly_when_claimed(self) -> RateClaimVerdict:
        quoted = self.sentence is not None and self.sentence.strip() != ""
        if quoted != self.claims_chosen_rate_in_effect:
            raise ValueError(
                "sentence must quote the claim when claims_chosen_rate_in_effect is true,"
                " and be null when it is false"
            )
        return self


class WithholdingClaimRequest(_Strict):
    """What ``judge_withholding_claim`` sends: the explain-w4 eval's question about
    one final row, with amounts formatted like the explain facts ("$423.16") and
    each outcome in words ("a balance due of $3,918.70")."""

    entries_withholding: str
    # None: no confirmed pay stub on the decision's schedule, so what is withheld
    # now is not known.
    pay_stub_withholding: str | None
    entries_outcome: str
    # None exactly when pay_stub_withholding is.
    pay_stub_outcome: str | None
    draft: ClaimDraft


class WithholdingClaimVerdict(_Strict):
    """``judge_withholding_claim`` output (spec 008 rule 24d): whether the draft says
    the withholding the W-4 entries give, or the projection with them, is what
    happens now, and the sentence that says so. It measures a draft in the eval
    and never gates one."""

    reason: str = Field(
        description=(
            "One or two sentences: which withholding each present-tense sentence describes,"
            " worked out before the answer"
        )
    )
    claims_entries_in_effect: bool = Field(
        description=(
            "True when a sentence describes the entries' withholding or their projection as"
            " what happens now"
        )
    )
    sentence: str | None = Field(
        default=None,
        description="The first sentence that makes the claim, copied exactly; null when none does",
    )

    @model_validator(mode="after")
    def _sentence_exactly_when_claimed(self) -> WithholdingClaimVerdict:
        quoted = self.sentence is not None and self.sentence.strip() != ""
        if quoted != self.claims_entries_in_effect:
            raise ValueError(
                "sentence must quote the claim when claims_entries_in_effect is true, and be"
                " null when it is false"
            )
        return self


SCHEMAS: dict[str, type[BaseModel]] = {
    "CategoryBatch": CategoryBatch,
    "PayStubExtraction": PayStubExtraction,
    "BenefitsExtraction": BenefitsExtraction,
    "BenefitsSummaryExtraction": BenefitsSummaryExtraction,
    "ExplanationDraft": ExplanationDraft,
    "RateClaimVerdict": RateClaimVerdict,
    "WithholdingClaimVerdict": WithholdingClaimVerdict,
}
