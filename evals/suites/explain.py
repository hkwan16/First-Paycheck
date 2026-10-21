"""The explain suite (LLM, spec 008 rule 24): the real draft-verify-retry flow
and model over 10 synthetic 401(k) decisions.

Each decision in ``evals/fixtures/explain/decisions.json`` is a ``k401_match``
input; its result is computed here with ``calc/k401.py``, and its citations
are the verified seed passages read from ``api/db/seed/irs_citations/``, so no
database is needed. The flow is ``verify.flow.run_explain`` exactly as
``POST /explain`` runs it. The gateway records to an in-memory ledger that
charges the run's ``Budget`` before each result is read.

Metrics (higher is better, 2-point tolerance):

- ``first_try_verified``: the share of decisions whose first draft verified.
- ``no_fallback``: one minus the share that ended on the fallback.
- ``cited``: the share whose final row cites at least one passage.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.config import Settings
from calc.k401 import K401MatchInput, k401_match
from db.seed.load import read_seed_citations
from evals.suites.base import Budget, Suite, SuiteResult, SuiteUnavailable
from llm.gateway import MICROCENTS_PER_CENT, LedgerEntry, LLMGateway, MemoryLedger
from retrieval.benefits_search import BenefitsPassage
from retrieval.citations import Citation
from retrieval.context import explain_context
from verify.allowed import AllowedNumbers
from verify.fallback import fallback_draft
from verify.flow import Attempt, Drafter, run_explain

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "explain" / "decisions.json"
EVAL_USER = uuid.UUID("00000000-0000-4000-8000-0000000e7a1e")
CALCULATOR = "k401_match"
# The gateway's per-user daily cap is not the eval's limit: --max-cost-cents is.
UNCAPPED_DAILY_CENTS = 1_000_000


@dataclass(frozen=True)
class EvalDecision:
    id: str
    inputs: dict[str, Any]
    result: dict[str, Any]
    tax_year: int
    benefits_passages: tuple[str, ...]


def load_decisions(path: Path = FIXTURES) -> list[EvalDecision]:
    """The fixture decisions, inputs and results in the stored (JSON) form."""
    decisions = []
    for entry in json.loads(path.read_text()):
        data = K401MatchInput.model_validate(entry["inputs"])
        decisions.append(
            EvalDecision(
                id=entry["id"],
                inputs=data.model_dump(mode="json"),
                result=k401_match(data).model_dump(mode="json"),
                tax_year=data.tax_year,
                benefits_passages=tuple(entry["benefits_passages"]),
            )
        )
    return decisions


def seed_citations(tax_year: int) -> list[Citation]:
    """The verified seed passages for the calculator, ordered by key (as loaded)."""
    return sorted(
        (
            Citation(
                key=entry.key,
                title=entry.title,
                url=entry.url,
                passage=entry.passage,
                source=entry.source,
                tax_year=entry.tax_year,
            )
            for entry in read_seed_citations()
            if entry.verified and entry.calculator == CALCULATOR and entry.tax_year == tax_year
        ),
        key=lambda citation: citation.key,
    )


def explain_decision(drafter: Drafter, decision: EvalDecision) -> list[Attempt]:
    """One run of the flow, as POST /explain runs it, without the database."""
    citations = seed_citations(decision.tax_year)
    passages = [
        BenefitsPassage(document_id=EVAL_USER, chunk_index=index, text=text, rank=1.0)
        for index, text in enumerate(decision.benefits_passages)
    ]
    keys = {citation.key for citation in citations}
    return run_explain(
        drafter,
        EVAL_USER,
        explain_context(CALCULATOR, decision.inputs, decision.result, citations, passages),
        AllowedNumbers.from_decision(decision.inputs, decision.result),
        keys,
        fallback_draft(CALCULATOR, decision.inputs, decision.result, keys),
    )


def score(decisions: Sequence[EvalDecision], drafter: Drafter) -> SuiteResult:
    first_try = fallbacks = cited = 0
    failures: list[str] = []
    for decision in decisions:
        attempts = explain_decision(drafter, decision)
        final = attempts[-1]
        first_try += attempts[0].verified
        fallbacks += final.fallback
        cited += bool(final.draft.citation_keys)
        for attempt in attempts:
            if not attempt.fallback and not attempt.verified:
                failures.append(
                    f"{decision.id} attempt {attempt.attempt}: "
                    + attempt.verification.feedback().replace("\n", "; ")
                )
        if final.fallback:
            failures.append(f"{decision.id}: fell back after {len(attempts) - 1} draft(s)")
    count = len(decisions)
    return SuiteResult(
        metrics={
            "first_try_verified": first_try / count if count else 1.0,
            "no_fallback": 1 - fallbacks / count if count else 1.0,
            "cited": cited / count if count else 1.0,
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
    result = score(load_decisions(), gateway)
    return SuiteResult(
        metrics=result.metrics,
        cases=result.cases,
        failures=result.failures,
        cost_cents=sum(spent),
    )


SUITE = Suite(name="explain", llm=True, run=run)
