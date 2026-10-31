"""The benefits-extraction suite (LLM, spec 013 rule 17): the real pipeline and
model over the 5 labeled synthetic summaries in ``evals/fixtures/benefits/``.

Each summary goes through ``prepare_document`` (read, redact), the real
``LLMGateway`` (``extract_benefits/v2``) and ``benefits_proposal``, exactly as
the ``ingest.extract`` job runs it, so the cumulative tiers scored are the ones
code computes from the bands the model reads. The gateway records to an
in-memory ledger that charges the run's ``Budget`` before the result is read.

Metrics (higher is better; each tolerates one case's worth or 2 points,
whichever is larger, as evals/CLAUDE.md says):

- ``plan_field_accuracy``: of the 8 fields of every labeled plan (matched in
  order), the share whose proposed value equals the label. A missing plan's
  fields are all wrong. ``employer_hsa_cents`` null and 0 are the same value
  (confirm stores 0 for a plan without one).
- ``retirement_accuracy``: the share of summaries whose computed tiers (bounds
  and shares) and ``vesting_years`` both equal the labels.
- ``document_accuracy``: the share with every plan field right, no extra plan
  and the retirement part right.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import replace
from typing import Any, Protocol

from evals.gen.make_benefits import Fixture, load_fixtures
from evals.suites.base import Budget, Suite, SuiteResult
from evals.suites.live import live_gateway
from ingest.pipeline import prepare_document
from ingest.proposal import PLAN_FIELDS, Proposal, benefits_proposal
from llm.gateway import (
    LLMError,
    ModelPage,
)
from llm.schemas import BenefitsSummaryExtraction

EVAL_USER = uuid.UUID("00000000-0000-4000-8000-0000000be7ef")
PLAN_KEYS = tuple(spec.key for spec in PLAN_FIELDS)
# Where null and 0 mean the same thing to confirm.
ZERO_IS_NULL = frozenset({"employer_hsa_cents"})


class BenefitsReader(Protocol):
    def extract_benefits(
        self, user_id: uuid.UUID, pages: Sequence[ModelPage], *, job_id: uuid.UUID | None = None
    ) -> BenefitsSummaryExtraction: ...


def _same(key: str, proposed: object, label: object) -> bool:
    if key in ZERO_IS_NULL:
        return (proposed or 0) == (label or 0)
    return proposed == label


def _plan_failures(document: str, proposal: Proposal, labels: dict[str, Any]) -> list[str]:
    failures = []
    for index, label in enumerate(labels["plans"]):
        if index >= len(proposal.plans):
            failures += [f"{document} plan {index} {key}: plan missing" for key in PLAN_KEYS]
            continue
        proposed = {field.key: field.value for field in proposal.plans[index].fields}
        failures += [
            f"{document} plan {index} {key}: expected {label[key]}, got {proposed[key]}"
            for key in PLAN_KEYS
            if not _same(key, proposed[key], label[key])
        ]
    return failures


def _retirement_failures(document: str, proposal: Proposal, labels: dict[str, Any]) -> list[str]:
    tiers = [{field.key: field.value for field in tier.fields} for tier in proposal.match_tiers]
    vesting = proposal.vesting_years.value if proposal.vesting_years is not None else None
    failures = []
    if tiers != labels["match_tiers"]:
        failures.append(f"{document} match_tiers: expected {labels['match_tiers']}, got {tiers}")
    if vesting != labels["vesting_years"]:
        failures.append(
            f"{document} vesting_years: expected {labels['vesting_years']}, got {vesting}"
        )
    return failures


def score(fixtures: Sequence[Fixture], reader: BenefitsReader) -> SuiteResult:
    plan_fields = sum(len(fixture.labels["plans"]) for fixture in fixtures) * len(PLAN_KEYS)
    wrong_fields = retirement_right = documents_right = 0
    failures: list[str] = []
    for fixture in fixtures:
        labels = fixture.labels
        document = labels["id"]
        expected_fields = len(labels["plans"]) * len(PLAN_KEYS)
        prepared = prepare_document(fixture.data, labels["content_type"])
        if not prepared.model_pages:
            failures.append(f"{document}: no readable page")
            wrong_fields += expected_fields
            continue
        try:
            extraction = reader.extract_benefits(EVAL_USER, prepared.model_pages)
        except LLMError as exc:
            failures.append(f"{document}: {type(exc).__name__}: {exc}")
            wrong_fields += expected_fields
            continue
        proposal = benefits_proposal(extraction, prepared.pages, prepared.withheld_pages)
        plan_failures = _plan_failures(document, proposal, labels)
        wrong_fields += len(plan_failures)
        extra = len(proposal.plans) - len(labels["plans"])
        if extra > 0:
            plan_failures.append(f"{document}: {extra} plan(s) not on the summary")
        retirement = _retirement_failures(document, proposal, labels)
        retirement_right += not retirement
        documents_right += not plan_failures and not retirement
        failures += plan_failures + retirement
    count = len(fixtures)
    return SuiteResult(
        metrics={
            "plan_field_accuracy": 1 - wrong_fields / plan_fields if plan_fields else 1.0,
            "retirement_accuracy": retirement_right / count if count else 1.0,
            "document_accuracy": documents_right / count if count else 1.0,
        },
        cases=count,
        failures=failures,
        # One case: a labeled plan field, a summary.
        case_worth={
            "plan_field_accuracy": 1 / plan_fields if plan_fields else 0.0,
            "retirement_accuracy": 1 / count if count else 0.0,
            "document_accuracy": 1 / count if count else 0.0,
        },
    )


def run(budget: Budget) -> SuiteResult:
    live = live_gateway(budget)
    result = score(load_fixtures(), live.gateway)
    return replace(result, cost_cents=live.spent_cents)


SUITE = Suite(name="benefits-extraction", llm=True, run=run)
