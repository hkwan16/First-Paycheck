"""verify/allowed.py and verify/verify.py on spec 006 example 1 (spec 008 rules 12-14)."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest

from calc.k401 import K401MatchInput, k401_match
from llm.schemas import ExplanationDraft, NumberClaim
from verify.allowed import AllowedNumbers
from verify.verify import verify_explanation

INPUTS = K401MatchInput.model_validate(
    {
        "salary_cents": 6_000_000,
        "pay_periods_per_year": 26,
        "match_tiers": [
            {"employee_pct_upto": "3", "employer_pct": "100"},
            {"employee_pct_upto": "5", "employer_pct": "50"},
        ],
        "contribution_pct": "3",
        "tax_year": 2026,
        "filing_status": "single",
        "age": 30,
    }
)
RESULT = k401_match(INPUTS)
ALLOWED = AllowedNumbers.from_decision(
    INPUTS.model_dump(mode="json"), RESULT.model_dump(mode="json")
)
KEYS = frozenset(RESULT.citation_keys)


def draft(text: str, **changes: Any) -> ExplanationDraft:
    fields: dict[str, Any] = {
        "concept": "Your employer matches part of what you put in.",
        "text": text,
        "numbers": [],
        "what_ifs": [],
        "citation_keys": ["k401.employer_match"],
        **changes,
    }
    return ExplanationDraft.model_validate(fields)


def test_allowed_numbers_from_example_1() -> None:
    dollars = {Decimal(v) for v in ("60000", "1800", "2400", "600", "3000", "46.15", "40.62")}
    assert dollars <= ALLOWED.money_exact
    assert {Decimal(46), Decimal(41), Decimal(24500)} <= ALLOWED.money_whole
    assert {Decimal(3), Decimal(5), Decimal(12), Decimal(100), Decimal(50)} == ALLOWED.percents
    assert {Decimal(2026), Decimal(26), Decimal(30)} == ALLOWED.plain


@pytest.mark.parametrize(
    "text",
    [
        "Moving from 3% to 5% adds $600.00 of match for $46.15 a paycheck.",
        "That is about $41 after tax at 12%.",
        "Over 26 paychecks in 2026 your $60,000 salary earns $2,400 of match.",
        "At 5.0% you get the full match; 5.00% is the same rate.",
        "Your take-home drops -$40.62 a paycheck.",
        "A match of 2,400 dollars.",
        "No numbers at all.",
    ],
)
def test_allowed_drafts_pass(text: str) -> None:
    verification = verify_explanation(draft(text), ALLOWED, KEYS)
    assert verification.passed, verification
    assert verification.numbers_unmatched == ()


@pytest.mark.parametrize(
    ("text", "unmatched"),
    [
        ("You would get $650 more.", ("$650",)),
        ("Raise it to 7%.", ("7%",)),
        ("That is $46.2 a paycheck.", ("$46.2",)),
        ("$2,400.50 of match", ("$2,400.50",)),
        ("Paid 24 times a year", ("24",)),
        ("Wait 3 years and 7% grows", ("3", "7%")),
    ],
)
def test_unknown_numbers_fail(text: str, unmatched: tuple[str, ...]) -> None:
    verification = verify_explanation(draft(text), ALLOWED, KEYS)
    assert not verification.passed
    assert verification.numbers_unmatched == unmatched


def test_every_field_is_checked() -> None:
    verification = verify_explanation(
        draft(
            "Fine: $600.00.",
            concept="Free money worth $999",
            what_ifs=["At 8% you would pay more."],
            numbers=[NumberClaim(value="$1,234.00", label="Missed at 9%")],
        ),
        ALLOWED,
        KEYS,
    )
    assert verification.numbers_unmatched == ("$999", "8%", "$1,234.00", "9%")
    assert verification.numbers_checked == 5


def test_a_claim_without_a_number_fails() -> None:
    verification = verify_explanation(
        draft("Fine.", numbers=[NumberClaim(value="a lot", label="Match")]), ALLOWED, KEYS
    )
    assert verification.numbers_unmatched == ("a lot",)


def test_unknown_citation_fails() -> None:
    verification = verify_explanation(draft("Fine.", citation_keys=["k401.made_up"]), ALLOWED, KEYS)
    assert not verification.passed
    assert verification.citations_unknown == ("k401.made_up",)
    assert verification.citations_checked == 1


def test_no_citation_fails() -> None:
    verification = verify_explanation(draft("Fine.", citation_keys=[]), ALLOWED, KEYS)
    assert not verification.passed
    assert verification.has_citation is False


def test_feedback_names_every_problem() -> None:
    verification = verify_explanation(
        draft("Get $650 at 7%.", citation_keys=["k401.made_up"]), ALLOWED, KEYS
    )
    feedback = verification.feedback()
    assert "$650" in feedback
    assert "7%" in feedback
    assert "k401.made_up" in feedback


def test_passing_verification_has_no_feedback_and_serializes() -> None:
    verification = verify_explanation(draft("At 5% you get $2,400.00."), ALLOWED, KEYS)
    assert verification.feedback() == ""
    assert verification.as_json() == {
        "numbers_checked": 2,
        "numbers_unmatched": [],
        "citations_checked": 1,
        "citations_unknown": [],
        "has_citation": True,
    }


def test_a_negative_money_value_is_allowed_by_its_magnitude() -> None:
    """Rule 13 ignores a money token's sign, so a negative result value (a net
    cost below zero, spec 012) is allowed written either way."""
    allowed = AllowedNumbers.from_decision({}, {"low_cost_cents": -40_300})
    for text in ("It costs -$403.00 a year.", "You come out $403.00 ahead.", "About $403."):
        draft = ExplanationDraft(
            concept="c", text=text, numbers=[], what_ifs=[], citation_keys=["k"]
        )
        assert verify_explanation(draft, allowed, {"k"}).passed, text
