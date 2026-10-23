"""The categorization-rules suite: the seed rules alone, no LLM, no database.

Each row of ``evals/fixtures/transactions.csv`` is normalized with
``normalize_merchant`` and matched against the seed rules
(``api/db/seed/category_rules.csv``) with the production ``RuleBook``.

Metrics (higher is better, deterministic, no drop tolerated):

- ``rules_precision``: of the rows a rule labels, the share labeled correctly.
- ``rules_coverage``: the share of rows a rule labels. ``1 - rules_coverage``
  is the LLM's share: the rows that would be sent to the gateway.

Each mislabeled row is reported as a failure line.
"""

from __future__ import annotations

from collections.abc import Sequence

from db.seed.load import SEED_CSV, read_seed_rules
from evals.gen.transactions import DEFAULT_CSV, Row, read_csv
from evals.suites.base import Budget, Suite, SuiteResult
from sync.categorize import RuleBook, normalize_merchant


def score(rows: Sequence[Row], rules: RuleBook | None = None) -> SuiteResult:
    rules = rules or RuleBook(read_seed_rules(SEED_CSV))
    covered = correct = 0
    failures: list[str] = []
    for row in rows:
        merchant_norm = normalize_merchant(row.merchant_raw)
        rule = rules.match(merchant_norm, amount_cents=row.amount_cents)
        if rule is None:
            continue
        covered += 1
        if rule.category == row.category:
            correct += 1
        else:
            failures.append(
                f"{row.id}: {merchant_norm} expected {row.category}, rules said {rule.category}"
            )
    return SuiteResult(
        metrics={
            "rules_precision": correct / covered if covered else 1.0,
            "rules_coverage": covered / len(rows) if rows else 1.0,
        },
        cases=len(rows),
        failures=failures,
    )


def run(budget: Budget) -> SuiteResult:
    return score(read_csv(DEFAULT_CSV))


SUITE = Suite(name="categorization-rules", llm=False, run=run)
