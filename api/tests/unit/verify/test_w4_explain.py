"""The explain context's facts and notes and the fallback text for W-4 decisions
(spec 014 rule 19), on spec 014's examples. Both must pass the verifier by
construction."""

from __future__ import annotations

from typing import Any

import pytest

from calc.w4 import W4Input, w4
from db.enums import CalculatorKind
from llm.schemas import ExplanationDraft
from retrieval.citations import Citation
from retrieval.context import BENEFITS_QUERIES, explain_context, name_numbers
from verify.allowed import AllowedNumbers
from verify.fallback import fallback_draft
from verify.numbers import extract_numbers
from verify.verify import verify_explanation

# Spec 014's examples and the edge cases with a suggestion, as input changes.
W4_EXAMPLES: dict[str, dict[str, Any]] = {
    "1": {"salary_cents": 5_187_000},
    "2b": {"salary_cents": 6_500_000, "pay_periods_per_year": 24},
    "3": {
        "salary_cents": 6_500_000,
        "k401_contribution_pct": "5",
        "health_premium_per_paycheck_cents": 6_250,
    },
    "4": {
        "salary_cents": 6_000_000,
        "filing_status": "married_filing_jointly",
        "multiple_jobs": True,
        "other_jobs_wages_cents": 6_000_000,
        "other_jobs_withholding_cents": 502_008,
    },
    "5": {
        "salary_cents": 5_000_000,
        "other_jobs_wages_cents": 2_000_000,
        "other_jobs_withholding_cents": 39_000,
    },
    "6": {
        "salary_cents": 4_000_000,
        "filing_status": "head_of_household",
        "dependents_credit_cents": 440_000,
    },
    "7": {
        "salary_cents": 8_000_000,
        "pay_periods_per_year": 24,
        "other_income_cents": 200_000,
        "deductions_cents": 500_000,
    },
    "8": {"salary_cents": 6_500_000, "extra_withholding_cents": 10_000},
    "9": {
        "salary_cents": 9_000_000,
        "filing_status": "married_filing_jointly",
        "multiple_jobs": True,
        "other_jobs_wages_cents": 3_000_000,
        "other_jobs_withholding_cents": 142_012,
    },
    "9-saved": {
        "salary_cents": 9_000_000,
        "filing_status": "married_filing_jointly",
        "multiple_jobs": True,
        "other_jobs_wages_cents": 3_000_000,
        "other_jobs_withholding_cents": 142_012,
        "deductions_cents": 1_068_300,
        "expected_deductions_cents": 0,
    },
    "10": {"salary_cents": 25_000_000, "k401_contribution_pct": "15", "age": 30},
    "step2-alone": {"salary_cents": 6_500_000, "multiple_jobs": True},
}
SEEDED_KEYS = (
    "w4.dependents_credit",
    "w4.federal_brackets",
    "w4.form_adjustments",
    "w4.multiple_jobs",
    "w4.percentage_method",
    "w4.pretax_deferral",
    "w4.standard_deduction",
)
SEEDED = [
    Citation(
        key=key,
        title=key,
        url="https://www.irs.gov/x",
        passage="Quoted words with $16,100 and Step 4(c).",
        source="Pub. 15-T",
        tax_year=2026,
    )
    for key in SEEDED_KEYS
]


def w4_decision(example: str) -> tuple[dict[str, Any], dict[str, Any]]:
    data = W4Input.model_validate(
        {
            "pay_periods_per_year": 26,
            "filing_status": "single",
            "tax_year": 2026,
            **W4_EXAMPLES[example],
        }
    )
    return data.model_dump(mode="json"), w4(data).model_dump(mode="json")


def facts_of(example: str) -> dict[str, str]:
    inputs, result = w4_decision(example)
    context = explain_context("w4", inputs, result, SEEDED, [])
    return {fact.label: fact.value for fact in context.facts}


def test_w4_has_a_benefits_query() -> None:
    assert "premium" in BENEFITS_QUERIES[CalculatorKind.W4]


def test_w4_context_for_example_5() -> None:
    inputs, result = w4_decision("5")
    context = explain_context("w4", inputs, result, SEEDED, [])
    facts = {fact.label: fact.value for fact in context.facts}
    assert facts["Federal income tax withheld per paycheck"] == "$146.92"
    assert facts["Federal income tax withheld per year"] == "$3,819.92"
    assert facts["Projected federal income tax for the year after credits"] == "$6,570.00"
    assert facts["Projected balance due"] == "$2,360.08"
    assert facts["Withholding table rate"] == "12%"
    assert facts["Other jobs' wages per year"] == "$20,000.00"
    assert facts["Suggested Step 4(c) extra withholding per paycheck"] == "$91.00"
    assert facts["Projected refund with the suggested entries"] == "$5.92"
    assert facts["Paychecks per year"] == "26"
    assert facts["Tax year"] == "2026"
    assert context.calculator == "w4"
    assert [c.key for c in context.citations][: len(result["citation_keys"])] == result[
        "citation_keys"
    ]
    assert any("balance due" in note for note in context.notes)
    # Facts are numbers only, so any fact a draft repeats shows a figure.
    for fact in context.facts:
        assert extract_numbers(fact.value), fact


def test_w4_context_shows_only_entries_that_are_set() -> None:
    facts = facts_of("1")
    assert "Projected balance due" in facts
    assert not any("Step 3" in label or "Step 4" in label for label in facts)
    assert not any("401(k)" in label for label in facts)
    facts = facts_of("3")
    assert facts["401(k) contributions per year, before tax"] == "$3,250.00"
    assert facts["Health premiums per year, before tax"] == "$1,625.00"
    facts = facts_of("7")
    assert facts["Step 4(a) other income per year"] == "$2,000.00"
    assert facts["Step 4(b) deductions per year"] == "$5,000.00"
    assert facts["Projected refund"] == "$0.08"


def test_w4_notes() -> None:
    def notes(example: str) -> list[str]:
        inputs, result = w4_decision(example)
        return explain_context("w4", inputs, result, SEEDED, []).notes

    assert any("half" in note for note in notes("4"))
    assert any("unchecked" in note for note in notes("step2-alone"))
    assert any("expected" in note for note in notes("9"))
    assert any("more than the tax" in note for note in notes("6"))
    assert any("limit" in note for note in notes("10"))
    for example in W4_EXAMPLES:
        for note in notes(example):
            assert not extract_numbers(note), (example, note)


@pytest.mark.parametrize("example", sorted(W4_EXAMPLES))
def test_every_w4_fact_passes_the_verifier(example: str) -> None:
    inputs, result = w4_decision(example)
    context = explain_context("w4", inputs, result, SEEDED, [])
    allowed = AllowedNumbers.from_decision(inputs, result, name_numbers("w4", inputs))
    for fact in context.facts:
        check = verify_explanation(
            ExplanationDraft(
                concept="c",
                text=" ".join([f"{fact.label}: {fact.value}.", *context.notes]),
                numbers=[],
                what_ifs=[],
                citation_keys=["w4.percentage_method"],
            ),
            allowed,
            {"w4.percentage_method"},
        )
        assert check.passed, (fact, check)


@pytest.mark.parametrize("example", sorted(W4_EXAMPLES))
def test_w4_fallback_passes_the_verifier(example: str) -> None:
    inputs, result = w4_decision(example)
    keys = set(SEEDED_KEYS)
    draft = fallback_draft("w4", inputs, result, keys)
    check = verify_explanation(draft, AllowedNumbers.from_decision(inputs, result), keys)
    assert check.passed, (draft.text, check)
    assert draft.citation_keys == result["citation_keys"]


def test_w4_fallback_for_example_5_reads_plainly() -> None:
    inputs, result = w4_decision("5")
    draft = fallback_draft("w4", inputs, result, {"w4.percentage_method"})
    assert "$146.92" in draft.text
    assert "owe about $2,360.08" in draft.text
    assert "$91.00" in draft.text
    assert "Step 4(c)" in draft.text
    assert draft.citation_keys == ["w4.percentage_method"]


def test_w4_fallback_for_example_9_explains_the_deductions_entry() -> None:
    inputs, result = w4_decision("9")
    draft = fallback_draft("w4", inputs, result, set())
    assert "$10,683.00" in draft.text
    assert "Step 4(b)" in draft.text
    assert draft.citation_keys == []
