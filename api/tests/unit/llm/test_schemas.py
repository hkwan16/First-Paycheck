"""Structured-output schemas the gateway validates model output against."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from llm.schemas import (
    SCHEMAS,
    CategoryBatch,
    ExplanationDraft,
    ExtractedField,
    PayStubExtraction,
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


def test_pay_stub_fields_are_extracted_fields() -> None:
    fields = PayStubExtraction.model_fields
    assert {"pay_date", "gross", "net", "federal_withholding"} <= fields.keys()
    empty = ExtractedField(value=None, confidence=0.0)
    stub = PayStubExtraction(**dict.fromkeys(fields, empty))
    assert stub.gross.value is None


def test_explanation_draft_shape() -> None:
    draft = ExplanationDraft(
        concept="Employer match",
        body="Contributing 4% earns the full match.",
        numbers=["4%"],
        citation_keys=["401k_deferral_limit"],
        what_ifs=[],
    )
    assert draft.citation_keys == ["401k_deferral_limit"]


def test_registry_names_every_schema() -> None:
    assert {
        "CategoryBatch": CategoryBatch,
        "PayStubExtraction": PayStubExtraction,
        "ExplanationDraft": ExplanationDraft,
    } == SCHEMAS
