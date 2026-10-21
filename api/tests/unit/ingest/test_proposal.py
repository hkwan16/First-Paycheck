"""From a model answer to reviewable fields, and the confirmed-values models
(spec 005 rules 3, 16-20)."""

from __future__ import annotations

import datetime as dt
import json
from decimal import Decimal
from typing import Any

import pytest
from pydantic import ValidationError

from ingest.proposal import (
    BenefitsValues,
    PayStubValues,
    PlanValues,
    SourcePage,
    benefits_proposal,
    benefits_text,
    manual_entry_proposal,
    pay_stub_proposal,
)
from llm.gateway import FAKE_FIXTURES
from llm.schemas import BenefitsExtraction, LineItem, PayStubExtraction, PlanExtraction
from tests.support.documents import ACME_STUB_LINES

STUB = PayStubExtraction.model_validate_json((FAKE_FIXTURES / "extract_pay_stub.json").read_text())
BENEFITS = BenefitsExtraction.model_validate_json(
    (FAKE_FIXTURES / "extract_benefits.json").read_text()
)
REDACTED_LINES = [
    line.replace("900-12-3456", "[REDACTED]").replace("000123456789", "[REDACTED]")
    for line in ACME_STUB_LINES
]
PAGES = [SourcePage(number=1, lines=REDACTED_LINES)]


def by_key(fields: list[Any]) -> dict[str, Any]:
    return {field.key: field for field in fields}


def test_fields_in_order_with_kind_and_role() -> None:
    proposal = pay_stub_proposal(STUB, PAGES, withheld_pages=[])
    assert [(f.key, f.kind, f.role) for f in proposal.fields] == [
        ("employer_name", "text", "info"),
        ("pay_date", "date", "info"),
        ("period_start", "date", "info"),
        ("period_end", "date", "info"),
        ("pay_frequency", "text", "info"),
        ("gross_cents", "money", "gross"),
        ("federal_withholding_cents", "money", "deduction"),
        ("social_security_cents", "money", "deduction"),
        ("medicare_cents", "money", "deduction"),
        ("state_tax_cents", "money", "deduction"),
        ("retirement_contribution_cents", "money", "deduction"),
        ("medical_premium_cents", "money", "deduction"),
        ("other_deductions_cents", "money", "deduction"),
        ("net_cents", "money", "net"),
    ]
    fields = by_key(proposal.fields)
    assert fields["gross_cents"].value == 270_833
    assert fields["gross_cents"].confidence == 0.99
    assert fields["gross_cents"].label == "Gross pay"
    assert fields["pay_date"].value == "2026-10-15"
    assert fields["pay_frequency"].value == "semimonthly"
    assert proposal.notes == STUB.notes


def test_other_deductions_sum_unassigned_lines() -> None:
    """Spec 005 hand-worked example: only deduction lines with no column count."""
    items = [
        LineItem(
            label="FED W/H", amount_cents=29_776, kind="tax", field="federal_withholding_cents"
        ),
        LineItem(label="CA SDI", amount_cents=3_250, kind="tax", field=None),
        LineItem(label="DENTAL/VIS", amount_cents=1_420, kind="pre_tax_deduction", field=None),
        LineItem(label="YTD GROSS", amount_cents=541_666, kind="info", field=None),
    ]
    stub = STUB.model_copy(update={"line_items": items})
    other = by_key(pay_stub_proposal(stub, PAGES, withheld_pages=[]).fields)[
        "other_deductions_cents"
    ]
    assert other.value == 4_670
    assert other.confidence is None
    assert other.note == "Sum of: CA SDI, DENTAL/VIS"


def test_fixture_other_deductions() -> None:
    other = by_key(pay_stub_proposal(STUB, PAGES, withheld_pages=[]).fields)[
        "other_deductions_cents"
    ]
    assert (other.value, other.note) == (4_670, "Sum of: CA SDI, Dental/Vision")


def test_line_items_are_kept_for_review() -> None:
    proposal = pay_stub_proposal(STUB, PAGES, withheld_pages=[])
    assert [(item.label, item.amount_cents, item.kind) for item in proposal.line_items][:2] == [
        ("Gross Pay", 270_833, "earning"),
        ("Federal Income Tax", 29_776, "tax"),
    ]
    assert proposal.line_items[5].field is None


def test_no_unassigned_lines_means_zero_other_deductions() -> None:
    stub = STUB.model_copy(update={"line_items": [item for item in STUB.line_items if item.field]})
    other = by_key(pay_stub_proposal(stub, PAGES, withheld_pages=[]).fields)[
        "other_deductions_cents"
    ]
    assert (other.value, other.note) == (0, "No other deductions listed")


def test_missing_values_say_so() -> None:
    fields = by_key(pay_stub_proposal(STUB, PAGES, withheld_pages=[]).fields)
    assert fields["retirement_contribution_cents"].value is None
    assert fields["retirement_contribution_cents"].note == "Not found on the document"
    assert fields["gross_cents"].note is None


def test_the_proposal_balances_for_the_mockup_stub() -> None:
    fields = by_key(pay_stub_proposal(STUB, PAGES, withheld_pages=[]).fields)
    deductions = sum(f.value or 0 for f in fields.values() if f.role == "deduction")
    assert fields["gross_cents"].value - deductions == fields["net_cents"].value


def test_source_lines_link_fields_and_flag_redactions() -> None:
    proposal = pay_stub_proposal(STUB, PAGES, withheld_pages=[3])
    lines = proposal.source_lines
    assert [line.text for line in lines] == REDACTED_LINES
    assert {line.page for line in lines} == {1}
    assert [line.text for line in lines if line.redacted] == [
        "SSN [REDACTED]",
        "Direct Deposit Acct [REDACTED]",
    ]
    linked = {line.text: line.field_key for line in lines if line.field_key}
    assert linked == {
        "ACME CORP EARNINGS STATEMENT": "employer_name",
        "Pay Date 10/15/2026": "pay_date",
        # period_end quotes the same line, which period_start already claimed.
        "Period 10/01/2026 - 10/15/2026": "period_start",
        "Pay Frequency Semi-monthly": "pay_frequency",
        "Gross Pay 2,708.33": "gross_cents",
        "Federal Income Tax 297.76": "federal_withholding_cents",
        "Social Security 167.92": "social_security_cents",
        "Medicare 39.27": "medicare_cents",
        "CA State Tax 98.14": "state_tax_cents",
        "Medical Pretax 62.50": "medical_premium_cents",
        "Net Pay 1,996.04": "net_cents",
    }
    assert proposal.withheld_pages == [3]


def test_money_falls_back_to_the_printed_amount() -> None:
    noisy = STUB.model_copy(
        update={
            "net_cents": STUB.net_cents.model_copy(update={"source_text": "NET PAY  $1,996.04 *"}),
            "medicare_cents": STUB.medicare_cents.model_copy(update={"source_text": None}),
        }
    )
    lines = pay_stub_proposal(noisy, PAGES, withheld_pages=[]).source_lines
    linked = {line.field_key: line.text for line in lines if line.field_key}
    assert linked["net_cents"] == "Net Pay 1,996.04"
    assert linked["medicare_cents"] == "Medicare 39.27"


def test_amount_fallback_matches_whole_amounts_only() -> None:
    zero = STUB.model_copy(
        update={
            "retirement_contribution_cents": STUB.retirement_contribution_cents.model_copy(
                update={"value": 0}
            )
        }
    )
    pages = [SourcePage(1, ["Bonus 10.00", "401(k) 0.00"])]
    lines = pay_stub_proposal(zero, pages, withheld_pages=[]).source_lines
    assert [line.field_key for line in lines] == [None, "retirement_contribution_cents"]


def test_matching_ignores_case_and_spacing() -> None:
    shouty = STUB.model_copy(
        update={
            "gross_cents": STUB.gross_cents.model_copy(
                update={"source_text": "  GROSS   PAY 2,708.33 "}
            )
        }
    )
    lines = pay_stub_proposal(shouty, PAGES, withheld_pages=[]).source_lines
    assert [line.field_key for line in lines if line.text == "Gross Pay 2,708.33"] == [
        "gross_cents"
    ]


def test_proposal_round_trips_through_json() -> None:
    proposal = pay_stub_proposal(STUB, PAGES, withheld_pages=[])
    stored = json.loads(proposal.model_dump_json())
    assert type(proposal).model_validate(stored) == proposal


def test_manual_entry_proposal_keeps_lines_and_leaves_fields_empty() -> None:
    proposal = manual_entry_proposal("pay_stub", PAGES, withheld_pages=[1])
    assert all(field.value is None for field in proposal.fields)
    assert len(proposal.fields) == 14
    assert proposal.source_lines[0].text == "ACME CORP EARNINGS STATEMENT"
    assert manual_entry_proposal("benefits", [], withheld_pages=[]).plans == []


def test_benefits_proposal_has_one_entry_per_plan() -> None:
    proposal = benefits_proposal(BENEFITS, PAGES, withheld_pages=[])
    assert proposal.fields == []
    assert len(proposal.plans) == 2
    gold = by_key(proposal.plans[1].fields)
    assert gold["name"].value == "Gold PPO"
    assert gold["kind"].value == "ppo"
    assert gold["coinsurance_pct"].value == "10.00"
    assert gold["coinsurance_pct"].kind == "percent"
    assert gold["employer_hsa_cents"].note == "Not found on the document"
    assert {f.role for plan in proposal.plans for f in plan.fields} == {"info"}


def test_benefits_text_joins_the_redacted_lines() -> None:
    proposal = benefits_proposal(BENEFITS, [SourcePage(1, ["Plan A", "SSN [REDACTED]"])], [])
    assert benefits_text(proposal) == "Plan A\nSSN [REDACTED]"


# Confirmed values -----------------------------------------------------------

VALUES: dict[str, Any] = {
    "employer_name": "Acme Corp",
    "pay_frequency": "semimonthly",
    "pay_date": "2026-10-15",
    "period_start": "2026-10-01",
    "period_end": "2026-10-15",
    "gross_cents": 270_833,
    "federal_withholding_cents": 29_776,
    "social_security_cents": 16_792,
    "medicare_cents": 3_927,
    "state_tax_cents": 9_814,
    "retirement_contribution_cents": 0,
    "medical_premium_cents": 6_250,
    "other_deductions_cents": 4_670,
    "net_cents": 199_604,
}


def test_values_mirror_the_extraction_schema() -> None:
    extracted = set(PayStubExtraction.model_fields) - {"line_items", "notes"}
    assert set(PayStubValues.model_fields) == extracted | {"other_deductions_cents"}
    assert set(PlanValues.model_fields) == set(PlanExtraction.model_fields)


def test_values_parse_and_balance() -> None:
    values = PayStubValues.model_validate(VALUES)
    assert values.pay_date == dt.date(2026, 10, 15)
    assert values.amounts().gross_cents == 270_833


@pytest.mark.parametrize(
    "change",
    [
        {"gross_cents": 0},
        {"gross_cents": 2708.33},
        {"medicare_cents": -1},
        {"net_cents": "199604"},
        {"period_start": "2026-10-16"},
        {"pay_frequency": "fortnightly"},
        {"employer_name": "x" * 201},
        {"surprise": 1},
    ],
)
def test_values_reject_bad_input(change: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        PayStubValues.model_validate({**VALUES, **change})


def test_values_require_every_amount() -> None:
    missing = {key: value for key, value in VALUES.items() if key != "state_tax_cents"}
    with pytest.raises(ValidationError, match="state_tax_cents"):
        PayStubValues.model_validate(missing)


PLAN: dict[str, Any] = {
    "name": "Gold PPO",
    "kind": "ppo",
    "premium_per_period_cents": 6_250,
    "deductible_cents": 50_000,
    "oop_max_cents": 300_000,
    "coinsurance_pct": "10",
    "employer_hsa_cents": 0,
    "enrollment_deadline": None,
}


def test_plan_values() -> None:
    plan = PlanValues.model_validate(PLAN)
    assert plan.coinsurance_pct == Decimal("10")
    with pytest.raises(ValidationError, match="deductible"):
        PlanValues.model_validate({**PLAN, "deductible_cents": 400_000})
    with pytest.raises(ValidationError):
        PlanValues.model_validate({**PLAN, "coinsurance_pct": "100.5"})
    with pytest.raises(ValidationError):
        BenefitsValues.model_validate({"plans": []})
