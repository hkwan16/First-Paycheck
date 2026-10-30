"""The extraction suite (LLM, spec 005 rule 26): the real pipeline and model
over the 30 labeled synthetic stubs in ``evals/fixtures/pay_stubs/``.

Each stub goes through ``prepare_document`` (read, OCR, redact), the real
``LLMGateway`` and the proposal builder, exactly as the ``ingest.extract`` job
runs it. The gateway records to an in-memory ledger that charges the run's
``Budget`` before the result is read, so ``--max-cost-cents`` is a hard cap.

Metrics (higher is better; each tolerates one case's worth or 2 points,
whichever is larger, as evals/CLAUDE.md says):

- ``field_accuracy``: of the 13 scored fields per stub (pay frequency, the
  three dates and the nine money fields including the computed other
  deductions), the share whose proposed value equals the label exactly.
- ``document_accuracy``: the share of stubs with all 13 right.

Redaction runs before the model and does not depend on it, so this suite does
not score it: ``extraction-smoke`` gates ``redaction_recall`` over the same
stubs at zero tolerance, where an LLM suite would tolerate one missed SSN.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import replace
from typing import Protocol

from app.config import Settings
from evals.gen.make_pay_stubs import Fixture, load_fixtures
from evals.suites.base import Budget, Suite, SuiteResult, SuiteUnavailable
from ingest.pipeline import prepare_document
from ingest.proposal import pay_stub_proposal
from llm.gateway import (
    MICROCENTS_PER_CENT,
    LedgerEntry,
    LLMError,
    LLMGateway,
    MemoryLedger,
    ModelPage,
)
from llm.schemas import PayStubExtraction

EVAL_USER = uuid.UUID("00000000-0000-4000-8000-0000000e7a1d")
SCORED_FIELDS = (
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
    "other_deductions_cents",
    "net_cents",
)
# The gateway's per-user daily cap is not the eval's limit: --max-cost-cents is.
UNCAPPED_DAILY_CENTS = 1_000_000


class PayStubReader(Protocol):
    def extract_pay_stub(
        self, user_id: uuid.UUID, pages: Sequence[ModelPage], *, job_id: uuid.UUID | None = None
    ) -> PayStubExtraction: ...


def score(fixtures: Sequence[Fixture], reader: PayStubReader) -> SuiteResult:
    right = documents_right = 0
    failures: list[str] = []
    for fixture in fixtures:
        labels = fixture.labels
        prepared = prepare_document(fixture.data, labels["content_type"])
        if not prepared.model_pages:
            failures.append(f"{labels['id']}: no readable page")
            continue
        try:
            stub = reader.extract_pay_stub(EVAL_USER, prepared.model_pages)
        except LLMError as exc:
            failures.append(f"{labels['id']}: {type(exc).__name__}: {exc}")
            continue
        proposal = pay_stub_proposal(stub, prepared.pages, prepared.withheld_pages)
        proposed = {field.key: field.value for field in proposal.fields}
        wrong = [key for key in SCORED_FIELDS if proposed[key] != labels["fields"][key]]
        right += len(SCORED_FIELDS) - len(wrong)
        documents_right += not wrong
        failures += [
            f"{labels['id']} {key}: expected {labels['fields'][key]}, got {proposed[key]}"
            for key in wrong
        ]
    count = len(fixtures)
    return SuiteResult(
        metrics={
            "field_accuracy": right / (count * len(SCORED_FIELDS)) if count else 1.0,
            "document_accuracy": documents_right / count if count else 1.0,
        },
        cases=count,
        failures=failures,
        # One case: a field, a stub.
        case_worth={
            "field_accuracy": 1 / (count * len(SCORED_FIELDS)) if count else 0.0,
            "document_accuracy": 1 / count if count else 0.0,
        },
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
    result = score(load_fixtures(), gateway)
    return replace(result, cost_cents=sum(spent))


SUITE = Suite(name="extraction", llm=True, run=run)
