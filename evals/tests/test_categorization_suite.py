"""The categorization LLM suite (spec 003 rule 29), scored with labelers that
answer from the labels, so no test calls the model."""

from __future__ import annotations

import uuid
from collections.abc import Sequence

import pytest

from evals.gen.transactions import DEFAULT_CSV, read_csv
from evals.suites import SUITES, categorization
from evals.suites.base import Budget, SuiteUnavailable
from llm.gateway import CategorizeItem, LLMRefused, LLMUnavailable
from llm.schemas import CategoryAssignment, CategoryBatch
from sync.categorize import normalize_merchant

ROWS = read_csv(DEFAULT_CSV)


class LabelLabeler:
    """Answers each merchant with its true category; records every batch."""

    def __init__(self, *, fail: Exception | None = None) -> None:
        self.truth = {normalize_merchant(row.merchant_raw): row.category for row in ROWS}
        self.batches: list[Sequence[CategorizeItem]] = []
        self.fail = fail

    def categorize(
        self,
        user_id: uuid.UUID,
        items: Sequence[CategorizeItem],
        *,
        job_id: uuid.UUID | None = None,
    ) -> CategoryBatch:
        self.batches.append(items)
        if self.fail is not None:
            raise self.fail
        return CategoryBatch(
            items=[
                # Validated, as the gateway validates the model's JSON.
                CategoryAssignment.model_validate(
                    {"id": item.id, "category": self.truth[item.merchant], "confidence": 0.9}
                )
                for item in items
            ]
        )


def rules_correct_share() -> float:
    plan = categorization.plan(ROWS)
    right = sum(
        plan.rule_labels[row.id] == row.category for row in ROWS if row.id in plan.rule_labels
    )
    return right / len(ROWS)


def test_a_perfect_labeler_scores_every_llm_row() -> None:
    result = categorization.score(ROWS, LabelLabeler())
    plan = categorization.plan(ROWS)
    llm_rows = len(ROWS) - len(plan.rule_labels)
    assert result.cases == 500
    assert result.metrics["llm_accuracy"] == 1.0
    assert result.metrics["accuracy"] == pytest.approx(rules_correct_share() + llm_rows / 500)


def test_batches_are_what_categorize_run_sends() -> None:
    labeler = LabelLabeler()
    categorization.score(ROWS, labeler)
    plan = categorization.plan(ROWS)
    sent = [item for batch in labeler.batches for item in batch]

    assert all(len(batch) <= 50 for batch in labeler.batches)
    for batch in labeler.batches:
        assert [item.id for item in batch] == list(range(1, len(batch) + 1))
    merchants = [item.merchant for item in sent]
    assert merchants == sorted(set(merchants))
    # Exactly the merchants no seed rule knows, each with its newest row.
    unknown = {
        normalize_merchant(row.merchant_raw) for row in ROWS if row.id not in plan.rule_labels
    }
    assert set(merchants) == unknown - {""}
    for item in sent:
        mine = [row for row in ROWS if normalize_merchant(row.merchant_raw) == item.merchant]
        newest = max(mine, key=lambda row: (row.posted_at, row.id))
        assert (item.amount_cents, item.date) == (newest.amount_cents, newest.posted_at)


def test_a_refused_batch_leaves_its_merchants_unlabeled() -> None:
    result = categorization.score(ROWS, LabelLabeler(fail=LLMRefused("refused")))
    assert result.metrics["llm_accuracy"] == 0.0
    assert result.metrics["accuracy"] == pytest.approx(rules_correct_share())
    assert result.failures == []


def test_a_gateway_error_is_a_failure_line() -> None:
    result = categorization.score(ROWS, LabelLabeler(fail=LLMUnavailable("overloaded")))
    assert result.metrics["llm_accuracy"] == 0.0
    assert any("LLMUnavailable" in line for line in result.failures)


def test_a_wrong_label_is_reported() -> None:
    recorder = LabelLabeler()
    categorization.score(ROWS, recorder)
    merchant = recorder.batches[0][0].merchant
    labeler = LabelLabeler()
    labeler.truth[merchant] = "taxes" if labeler.truth[merchant] != "taxes" else "fees"
    result = categorization.score(ROWS, labeler)
    assert result.metrics["llm_accuracy"] < 1.0
    assert any(merchant in line for line in result.failures)


def test_categorization_needs_an_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    no_key = categorization.Settings(_env_file=None, anthropic_api_key=None)
    monkeypatch.setattr(categorization, "_settings", lambda: no_key)
    with pytest.raises(SuiteUnavailable, match="ANTHROPIC_API_KEY"):
        categorization.run(Budget(100))


def test_it_is_registered_as_an_llm_suite() -> None:
    assert SUITES["categorization"].llm is True
