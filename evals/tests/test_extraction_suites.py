"""The extraction suites (spec 005 rules 26-27)."""

from __future__ import annotations

import os
import shutil
import uuid
from collections.abc import Iterator, Sequence
from typing import Any

import pytest

from evals.gen.make_pay_stubs import load_fixtures
from evals.suites import SUITES, extraction, extraction_smoke
from evals.suites.base import Budget, SuiteUnavailable
from llm.gateway import ModelPage
from llm.schemas import PayStubExtraction

FIXTURES = load_fixtures()


@pytest.fixture
def tesseract() -> None:
    if shutil.which("tesseract"):
        return
    if os.environ.get("CI"):
        pytest.fail("tesseract must be installed in CI")
    pytest.skip("tesseract is not installed")


class LabelReader:
    """Answers each stub with its labels, optionally with one field wrong."""

    def __init__(self, labels: Sequence[dict[str, Any]], *, off_by_one: str | None = None) -> None:
        self._labels: Iterator[dict[str, Any]] = iter(labels)
        self._off_by_one = off_by_one
        self.pages: list[Sequence[ModelPage]] = []

    def extract_pay_stub(
        self, user_id: uuid.UUID, pages: Sequence[ModelPage], *, job_id: uuid.UUID | None = None
    ) -> PayStubExtraction:
        self.pages.append(pages)
        fields = dict(next(self._labels)["fields"])
        if self._off_by_one is not None:
            fields[self._off_by_one] += 1
        other = fields.pop("other_deductions_cents")
        answer: dict[str, Any] = {
            key: {"value": value, "confidence": 0.99, "source_text": None}
            for key, value in fields.items()
        }
        answer["line_items"] = (
            [{"label": "Other", "amount_cents": other, "kind": "tax", "field": None}]
            if other
            else []
        )
        answer["notes"] = None
        return PayStubExtraction.model_validate(answer)


def text_fixtures() -> list[Any]:
    """The text-layer stubs: no OCR needed, so these run anywhere."""
    return [fixture for fixture in FIXTURES if fixture.labels["output"] == "text_pdf"]


def test_both_suites_are_registered() -> None:
    assert SUITES["extraction"].llm is True
    assert SUITES["extraction-smoke"].llm is False


def test_a_perfect_reader_scores_full_marks() -> None:
    fixtures = text_fixtures()
    result = extraction.score(fixtures, LabelReader([f.labels for f in fixtures]))
    assert result.metrics == {
        "field_accuracy": 1.0,
        "document_accuracy": 1.0,
        "redaction_recall": 1.0,
    }
    assert result.cases == len(fixtures)
    assert result.failures == []


def test_one_wrong_field_per_stub() -> None:
    fixtures = text_fixtures()
    result = extraction.score(
        fixtures, LabelReader([f.labels for f in fixtures], off_by_one="net_cents")
    )
    assert result.metrics["field_accuracy"] == pytest.approx(12 / 13)
    assert result.metrics["document_accuracy"] == 0.0
    assert len(result.failures) == len(fixtures)
    first = fixtures[0].labels
    assert result.failures[0] == (
        f"{first['id']} net_cents: expected {first['fields']['net_cents']},"
        f" got {first['fields']['net_cents'] + 1}"
    )


def test_the_reader_sees_only_redacted_text() -> None:
    fixtures = text_fixtures()
    reader = LabelReader([f.labels for f in fixtures])
    extraction.score(fixtures, reader)
    for fixture, pages in zip(fixtures, reader.pages, strict=True):
        sent = " ".join(getattr(page, "text", "") for page in pages)
        for secret in (fixture.labels["ssn"], fixture.labels["account_number"]):
            if secret is not None:
                assert secret not in sent


def test_extraction_needs_an_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    # Explicitly no key: a key in the shell's environment must not make this a live call.
    no_key = extraction.Settings(_env_file=None, anthropic_api_key=None)
    monkeypatch.setattr(extraction, "_settings", lambda: no_key)
    with pytest.raises(SuiteUnavailable, match="ANTHROPIC_API_KEY"):
        extraction.run(Budget(100))


def test_smoke_suite_on_text_stubs() -> None:
    result = extraction_smoke.score(text_fixtures())
    assert result.metrics == {"pipeline_ok": 1.0, "redaction_recall": 1.0, "ssn_free": 1.0}
    assert result.cost_cents == 0.0


def test_smoke_suite_on_every_stub(tesseract: None) -> None:
    result = extraction_smoke.run(Budget(0))
    assert result.cases == 10
    assert result.metrics == {"pipeline_ok": 1.0, "redaction_recall": 1.0, "ssn_free": 1.0}, (
        result.failures
    )
