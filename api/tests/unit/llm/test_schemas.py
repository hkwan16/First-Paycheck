"""Structured-output schemas the gateway validates model output against."""

from __future__ import annotations

import datetime as dt

import pytest
from pydantic import ValidationError

from llm.schemas import (
    SCHEMAS,
    BenefitsExtraction,
    BenefitsSummaryExtraction,
    CategoryBatch,
    ExplanationDraft,
    ExtractedField,
    NumberClaim,
    PayStubExtraction,
    RateClaimDraft,
    RateClaimRequest,
    RateClaimVerdict,
)


def test_category_batch_accepts_known_categories() -> None:
    batch = CategoryBatch.model_validate_json(
        '{"items": [{"id": 1, "category": "subscriptions", "confidence": 0.97}]}'
    )
    assert batch.items[0].category == "subscriptions"


@pytest.mark.parametrize(
    "item",
    [
        '{"id": 1, "category": "snacks", "confidence": 0.5}',
        '{"id": 0, "category": "dining", "confidence": 0.5}',
        '{"id": 1, "category": "dining", "confidence": 1.5}',
        '{"id": 1, "category": "dining", "confidence": 0.5, "note": "extra"}',
        '{"id": 1, "category": "dining"}',
    ],
)
def test_category_batch_rejects_bad_items(item: str) -> None:
    with pytest.raises(ValidationError):
        CategoryBatch.model_validate_json(f'{{"items": [{item}]}}')


PAY_STUB_COLUMNS = {
    "employer_name",
    "pay_frequency",
    "pay_date",
    "period_start",
    "period_end",
    "gross_cents",
    "federal_withholding_cents",
    "social_security_cents",
    "medicare_cents",
    "state_tax_cents",
    "retirement_contribution_cents",
    "medical_premium_cents",
    "net_cents",
}


def field(value: object, confidence: float = 0.9, source: str | None = None) -> dict[str, object]:
    return {"value": value, "confidence": confidence, "source_text": source}


def stub_json(**overrides: object) -> dict[str, object]:
    data: dict[str, object] = {
        "employer_name": field("Acme Corp"),
        "pay_frequency": field("semimonthly"),
        "pay_date": field("2026-10-15"),
        "period_start": field("2026-10-01"),
        "period_end": field("2026-10-15"),
        "gross_cents": field(270_833, source="Gross Pay 2,708.33"),
        "federal_withholding_cents": field(29_776),
        "social_security_cents": field(16_792),
        "medicare_cents": field(3_927),
        "state_tax_cents": field(9_814),
        "retirement_contribution_cents": field(None, 0.4),
        "medical_premium_cents": field(6_250),
        "net_cents": field(199_604),
        "line_items": [
            {"label": "CA SDI", "amount_cents": 3_250, "kind": "tax", "field": None},
            {
                "label": "FED W/H",
                "amount_cents": 29_776,
                "kind": "tax",
                "field": "federal_withholding_cents",
            },
        ],
        "notes": None,
    }
    data.update(overrides)
    return data


def test_pay_stub_has_an_extracted_field_per_printed_column() -> None:
    fields = PayStubExtraction.model_fields
    assert fields.keys() - {"line_items", "notes"} == PAY_STUB_COLUMNS
    stub = PayStubExtraction.model_validate(stub_json())
    assert stub.gross_cents.value == 270_833
    assert stub.gross_cents.source_text == "Gross Pay 2,708.33"
    assert stub.pay_date.value == dt.date(2026, 10, 15)
    assert stub.retirement_contribution_cents.value is None
    assert stub.line_items[1].field == "federal_withholding_cents"


@pytest.mark.parametrize(
    "override",
    [
        {"gross_cents": field(-1)},
        {"gross_cents": field(2708.33)},
        {"gross_cents": field("2,708.33")},
        {"pay_date": field("10/15/2026")},
        {"pay_frequency": field("fortnightly")},
        {"net_cents": field(199_604, confidence=1.2)},
        {"line_items": [{"label": "X", "amount_cents": 1, "kind": "bonus", "field": None}]},
        {"line_items": [{"label": "X", "amount_cents": 1, "kind": "tax", "field": "net"}]},
    ],
)
def test_pay_stub_rejects_bad_values(override: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        PayStubExtraction.model_validate(stub_json(**override))


def test_extracted_field_is_generic() -> None:
    assert ExtractedField[int](value=5, confidence=1, source_text=None).value == 5
    with pytest.raises(ValidationError):
        ExtractedField[int].model_validate({"value": "five", "confidence": 1, "source_text": None})


def test_benefits_extraction_lists_plans() -> None:
    plan = {
        "name": field("Gold PPO"),
        "kind": field("ppo"),
        "premium_per_period_cents": field(6_250),
        "deductible_cents": field(50_000),
        "oop_max_cents": field(300_000),
        "coinsurance_pct": field(20),
        "employer_hsa_cents": field(None),
        "enrollment_deadline": field("2026-11-15"),
    }
    benefits = BenefitsExtraction.model_validate({"plans": [plan], "notes": "Two pages"})
    assert benefits.plans[0].kind.value == "ppo"
    assert benefits.plans[0].coinsurance_pct.value == 20
    with pytest.raises(ValidationError):
        BenefitsExtraction.model_validate(
            {"plans": [{**plan, "kind": field("epo")}], "notes": None}
        )


def test_benefits_summary_adds_the_match_and_vesting() -> None:
    """Spec 013 rules 1-3: bands as printed, each with its own confidence."""
    tier = {"band_pct": field(3), "employer_pct": field(100)}
    summary = BenefitsSummaryExtraction.model_validate(
        {"plans": [], "match_tiers": [tier], "vesting_years": field(3), "notes": None}
    )
    assert summary.match_tiers[0].band_pct.value == 3
    assert summary.match_tiers[0].employer_pct.confidence == 0.9
    assert summary.vesting_years.value == 3
    for bad in (
        {"vesting_years": field(11)},
        {"vesting_years": field(2.5)},
        {"match_tiers": [{**tier, "employer_pct": field(101)}]},
        {"match_tiers": [{**tier, "cumulative": field(5)}]},
    ):
        with pytest.raises(ValidationError):
            BenefitsSummaryExtraction.model_validate(
                {
                    "plans": [],
                    "match_tiers": [tier],
                    "vesting_years": field(3),
                    "notes": None,
                    **bad,
                }
            )


def test_explanation_draft_shape() -> None:
    draft = ExplanationDraft.model_validate(
        {
            "concept": "Employer match",
            "text": "Contributing 5% earns the full match of $2,400.00.",
            "numbers": [{"value": "$2,400.00", "label": "Full match"}],
            "what_ifs": ["At 4% you would get $2,100.00."],
            "citation_keys": ["k401.employer_match"],
        }
    )
    assert draft.numbers == [NumberClaim(value="$2,400.00", label="Full match")]
    assert draft.citation_keys == ["k401.employer_match"]
    with pytest.raises(ValidationError):
        ExplanationDraft.model_validate({**draft.model_dump(), "body": "old field"})
    with pytest.raises(ValidationError, match="what_ifs"):
        ExplanationDraft.model_validate({**draft.model_dump(), "what_ifs": ["a", "b", "c", "d"]})


def test_registry_names_every_schema() -> None:
    assert {
        "CategoryBatch": CategoryBatch,
        "PayStubExtraction": PayStubExtraction,
        "BenefitsExtraction": BenefitsExtraction,
        "BenefitsSummaryExtraction": BenefitsSummaryExtraction,
        "ExplanationDraft": ExplanationDraft,
        "RateClaimVerdict": RateClaimVerdict,
    } == SCHEMAS


def test_rate_claim_request_holds_the_three_rates_and_the_draft() -> None:
    """Spec 008 rule 24a: the judge reads the rates and the draft's words, nothing else."""
    request = RateClaimRequest(
        chosen_rate="5%",
        pay_stub_rate=None,
        full_match_rate="5%",
        draft=RateClaimDraft(concept="c", text="t", what_ifs=["w"]),
    )
    assert request.model_dump(mode="json") == {
        "chosen_rate": "5%",
        "pay_stub_rate": None,
        "full_match_rate": "5%",
        "draft": {"concept": "c", "text": "t", "what_ifs": ["w"]},
    }
    with pytest.raises(ValidationError):
        RateClaimDraft.model_validate({"concept": "c", "text": "t", "what_ifs": [], "numbers": []})


def test_rate_claim_verdict_quotes_a_sentence_exactly_when_it_claims() -> None:
    claim = RateClaimVerdict.model_validate_json(
        '{"reason": "It calls the chosen 5% current.", "claims_chosen_rate_in_effect": true,'
        ' "sentence": "You are already contributing 5%."}'
    )
    assert claim.sentence == "You are already contributing 5%."
    none = RateClaimVerdict(reason="Only the stub is current.", claims_chosen_rate_in_effect=False)
    assert none.sentence is None
    with pytest.raises(ValidationError, match="sentence"):
        RateClaimVerdict(reason="r", claims_chosen_rate_in_effect=True, sentence=None)
    with pytest.raises(ValidationError, match="sentence"):
        RateClaimVerdict(reason="r", claims_chosen_rate_in_effect=True, sentence="  ")
    with pytest.raises(ValidationError, match="sentence"):
        RateClaimVerdict(reason="r", claims_chosen_rate_in_effect=False, sentence="You are at 3%.")
