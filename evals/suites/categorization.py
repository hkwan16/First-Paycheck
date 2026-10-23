"""The categorization suite (LLM, spec 003 rule 29): the seed rules, then Haiku
for every merchant no rule knows, over the labeled rows of
``evals/fixtures/transactions.csv``, with no database.

It mirrors ``categorize.run`` (spec 003 rules 8-10): each unknown non-empty
``merchant_norm`` and direction (money out, money in) goes to the model once,
as its newest row, in merchant order with money out first, 50 per call, and
its label applies to every row of that merchant and direction; a spending
label for a money-in item is dropped, as the job drops it. The real
``LLMGateway`` records to an in-memory ledger that charges the run's
``Budget`` before the answer is read, so ``--max-cost-cents`` is a hard cap.

Metrics (higher is better, 2-point tolerance):

- ``accuracy``: the share of all rows whose final category equals the label
  (an unlabeled row is wrong).
- ``llm_accuracy``: the same share over the rows whose merchant went to the
  model.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from app.config import Settings
from db.seed.load import SEED_CSV, read_seed_rules
from evals.gen.transactions import DEFAULT_CSV, Row, read_csv
from evals.suites.base import Budget, Suite, SuiteResult, SuiteUnavailable
from llm.gateway import (
    MICROCENTS_PER_CENT,
    CategorizeItem,
    LedgerEntry,
    LLMError,
    LLMGateway,
    LLMRefused,
    MemoryLedger,
)
from llm.schemas import CategoryBatch
from sync.categories import allowed_for, is_money_in
from sync.categorize import BATCH_SIZE, RuleBook, Unit, normalize_merchant

EVAL_USER = uuid.UUID("00000000-0000-4000-8000-0000000ca7e9")
# The gateway's per-user daily cap is not the eval's limit: --max-cost-cents is.
UNCAPPED_DAILY_CENTS = 1_000_000


class CategoryLabeler(Protocol):
    def categorize(
        self,
        user_id: uuid.UUID,
        items: Sequence[CategorizeItem],
        *,
        job_id: uuid.UUID | None = None,
    ) -> CategoryBatch: ...


@dataclass(frozen=True)
class Plan:
    """What the rules label (row id to category) and what goes to the model."""

    rule_labels: dict[int, str]
    # One item per unknown merchant and direction, its newest row, in merchant
    # order with money out first.
    samples: list[Row]


def unit_of(row: Row) -> Unit:
    """The merchant and direction the job labels ``row`` by (spec 003 rule 8)."""
    return normalize_merchant(row.merchant_raw), is_money_in(row.amount_cents)


def plan(rows: Sequence[Row], rules: RuleBook | None = None) -> Plan:
    rules = rules or RuleBook(read_seed_rules(SEED_CSV))
    rule_labels: dict[int, str] = {}
    newest: dict[Unit, Row] = {}
    for row in rows:
        unit = unit_of(row)
        rule = rules.match(unit[0], amount_cents=row.amount_cents)
        if rule is not None:
            rule_labels[row.id] = rule.category
        elif unit[0]:
            seen = newest.get(unit)
            if seen is None or (row.posted_at, row.id) > (seen.posted_at, seen.id):
                newest[unit] = row
    return Plan(rule_labels=rule_labels, samples=[newest[unit] for unit in sorted(newest)])


def score(
    rows: Sequence[Row], labeler: CategoryLabeler, rules: RuleBook | None = None
) -> SuiteResult:
    planned = plan(rows, rules)
    by_unit: dict[Unit, str] = {}
    failures: list[str] = []
    samples = planned.samples
    for start in range(0, len(samples), BATCH_SIZE):
        batch = samples[start : start + BATCH_SIZE]
        items = [
            CategorizeItem(
                id=index,
                merchant=normalize_merchant(row.merchant_raw),
                amount_cents=row.amount_cents,
                date=row.posted_at,
            )
            for index, row in enumerate(batch, start=1)
        ]
        try:
            answer = labeler.categorize(EVAL_USER, items)
        except LLMRefused:
            continue  # spec 003 rule 12: the batch's merchants stay unlabeled
        except LLMError as exc:
            failures.append(f"batch {start // BATCH_SIZE + 1}: {type(exc).__name__}: {exc}")
            continue
        by_id = {item.id: item for item in items}
        for assignment in answer.items:
            item = by_id.get(assignment.id)
            # A spending label for a money-in item is dropped (spec 003 rule 10).
            if item is not None and allowed_for(assignment.category, item.amount_cents):
                by_unit[(item.merchant, is_money_in(item.amount_cents))] = assignment.category

    right = llm_rows = llm_right = 0
    for row in rows:
        if row.id in planned.rule_labels:
            right += planned.rule_labels[row.id] == row.category
            continue
        unit = unit_of(row)
        label = by_unit.get(unit)
        llm_rows += 1
        if label == row.category:
            right += 1
            llm_right += 1
        elif unit in by_unit:
            failures.append(f"{row.id}: {unit[0]} expected {row.category}, model said {label}")
    count = len(rows)
    return SuiteResult(
        metrics={
            "accuracy": right / count if count else 1.0,
            "llm_accuracy": llm_right / llm_rows if llm_rows else 1.0,
        },
        cases=count,
        failures=failures,
    )


def _settings() -> Settings:
    return Settings()


def run(budget: Budget) -> SuiteResult:
    settings = _settings()
    if settings.anthropic_api_key is None:
        raise SuiteUnavailable("ANTHROPIC_API_KEY is not set")
    spent: list[float] = []

    def charge(entry: LedgerEntry) -> None:
        cents = entry.cost_microcents / MICROCENTS_PER_CENT
        spent.append(cents)
        budget.charge(cents)

    gateway = LLMGateway(
        settings.model_copy(
            update={"llm_fake": False, "llm_daily_budget_cents": UNCAPPED_DAILY_CENTS}
        ),
        ledger=MemoryLedger(on_record=charge),
    )
    result = score(read_csv(DEFAULT_CSV), gateway)
    return SuiteResult(
        metrics=result.metrics,
        cases=result.cases,
        failures=result.failures,
        cost_cents=sum(spent),
    )


SUITE = Suite(name="categorization", llm=True, run=run)
