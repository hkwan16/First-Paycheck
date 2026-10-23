"""The categorization-rules suite and its seeded transaction generator."""

from __future__ import annotations

import csv
import json
from pathlib import Path

from evals.gen import transactions as gen
from evals.suites import SUITES, categorization_rules
from evals.suites.base import Budget
from sync.categories import CATEGORIES

BASELINE = Path(__file__).resolve().parents[1] / "baseline.json"


def test_the_committed_csv_regenerates_identically(tmp_path: Path) -> None:
    fresh = tmp_path / "transactions.csv"
    gen.write_csv(fresh)
    assert fresh.read_text() == gen.DEFAULT_CSV.read_text(), (
        "evals/fixtures/transactions.csv is stale: run `uv run python -m evals.gen.transactions`"
    )


def test_generation_is_deterministic_and_seed_dependent() -> None:
    assert gen.generate() == gen.generate()
    assert gen.generate(seed=1) != gen.generate()


def test_rows_are_well_formed() -> None:
    with gen.DEFAULT_CSV.open(newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert len(rows) == 515
    assert list(rows[0]) == ["id", "merchant_raw", "amount_cents", "posted_at", "category"]
    assert len({row["id"] for row in rows}) == 515
    assert {row["category"] for row in rows} <= set(CATEGORIES)
    income = [int(row["amount_cents"]) for row in rows if row["category"] == "income"]
    assert income
    assert all(amount < 0 for amount in income)


def test_suite_scores_rules_only() -> None:
    result = categorization_rules.run(Budget(0))
    assert result.cases == 515
    assert set(result.metrics) == {"rules_precision", "rules_coverage"}
    assert 0.9 <= result.metrics["rules_precision"] < 1.0
    # Some merchants no rule knows: they are the LLM's share.
    assert 0.5 < result.metrics["rules_coverage"] < 1.0
    assert result.cost_cents == 0.0
    # Every rule mistake is listed.
    assert result.failures
    assert all("expected" in failure for failure in result.failures)


def test_scoring_on_hand_made_rows() -> None:
    rows = [
        gen.Row(1, "SAFEWAY #12", 1000, gen.START, "groceries"),
        gen.Row(2, "RENT THE RUNWAY", 5000, gen.START, "shopping"),
        gen.Row(3, "ZZ UNHEARD OF", 100, gen.START, "other"),
        gen.Row(4, "#1234", 100, gen.START, "other"),
    ]
    result = categorization_rules.score(rows)
    assert result.metrics == {"rules_precision": 0.5, "rules_coverage": 0.5}
    assert result.failures == ["2: rent the runway expected shopping, rules said housing"]


def test_the_hand_written_rows_follow_the_seeded_ones() -> None:
    rows = gen.generate()
    assert [row.id for row in rows] == list(range(1, 516))
    assert [row.merchant_raw for row in rows[500:]] == [case[0] for case in gen.SIGN_CASES]


def test_rules_follow_the_direction_on_the_hand_written_rows() -> None:
    """Spec 003 rules 3b and 5a: paychecks named like merchants are income, the
    bank descriptors are labeled, and refunds keep their merchant's category."""
    rows = gen.generate()[500:]
    result = categorization_rules.score(rows)
    assert result.failures == []
    assert result.metrics["rules_precision"] == 1.0
    assert result.metrics["rules_coverage"] == 1.0


def test_registered_with_a_baseline() -> None:
    assert SUITES["categorization-rules"] is categorization_rules.SUITE
    assert not categorization_rules.SUITE.llm
    assert "categorization-rules" in json.loads(BASELINE.read_text())
