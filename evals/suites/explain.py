"""The explain suite (LLM, spec 008 rule 24): the real draft-verify-retry flow
and model over 29 synthetic 401(k) decisions.

Each decision in ``evals/fixtures/explain/decisions.json`` is a ``k401_match``
input and the rate its pay stub shows (``pay_stub_contribution_pct``, null for
no stub; spec 008 rule 7a), 14 of them a rate other than the one chosen; its
result is computed here through ``calc/registry.py`` (the explain-smoke suite
also loads ``w4_decisions.json`` this way), and its citations
are the verified seed passages read from ``api/db/seed/irs_citations/``, so no
database is needed. The flow is ``verify.flow.run_explain`` exactly as
``POST /explain`` runs it. The gateway records to an in-memory ledger that
charges the run's ``Budget`` before each result is read.

Metrics (higher is better; each tolerates one case's worth or 2 points,
whichever is larger, as evals/CLAUDE.md says):

- ``first_try_verified``: the share of decisions whose first draft verified.
- ``no_fallback``: one minus the share that ended on the fallback.
- ``cited``: the share whose final row cites at least one passage.
- ``rate_framing``: over the 401(k) decisions whose pay stub does not show the
  chosen rate (another rate, or no stub), the share whose final row does not
  claim the chosen rate is already in effect (issue 132). Scored by
  ``rate_claim``, an eval heuristic over each sentence (the person as the
  subject of "already", or the rate chosen called already in effect), so it
  measures drafts and never gates one.
"""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any

from app.config import Settings
from calc.pay_stub import StubRate, stub_rate
from calc.registry import calculator as registered_calculator
from db.seed.load import read_seed_citations
from evals.suites.base import Budget, Suite, SuiteResult, SuiteUnavailable
from llm.gateway import MICROCENTS_PER_CENT, LedgerEntry, LLMGateway, MemoryLedger
from llm.schemas import ExplanationDraft
from retrieval.benefits_search import BenefitsPassage
from retrieval.citations import Citation
from retrieval.context import explain_setup
from verify.flow import Attempt, Drafter, run_explain

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "explain" / "decisions.json"
# The explain-smoke suite's W-4 decision (spec 014 rule 19); the live suite stays on
# the 401(k) decisions.
W4_FIXTURES = FIXTURES.with_name("w4_decisions.json")
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
    calculator: str = CALCULATOR
    # The rate the newest confirmed pay stub shows, None for no stub (rule 7a).
    pay_stub_pct: Decimal | None = None


def load_decisions(path: Path = FIXTURES) -> list[EvalDecision]:
    """The fixture decisions, inputs and results in the stored (JSON) form. An entry
    names its ``calculator`` (default ``k401_match``); the registry computes its result.
    ``pay_stub_contribution_pct`` is the stub's rate as the API reports it, or null."""
    decisions = []
    for entry in json.loads(path.read_text()):
        name = entry.get("calculator", CALCULATOR)
        spec = registered_calculator(name)
        data = spec.input_model.model_validate(entry["inputs"])
        inputs = data.model_dump(mode="json")
        decisions.append(
            EvalDecision(
                id=entry["id"],
                inputs=inputs,
                result=spec.run(data).model_dump(mode="json"),
                tax_year=int(inputs["tax_year"]),
                benefits_passages=tuple(entry["benefits_passages"]),
                calculator=name,
                pay_stub_pct=_rate(entry.get("pay_stub_contribution_pct")),
            )
        )
    return decisions


def _rate(value: str | None) -> Decimal | None:
    return None if value is None else Decimal(value)


def seed_citations(tax_year: int, calculator: str = CALCULATOR) -> list[Citation]:
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
            if entry.verified and entry.calculator == calculator and entry.tax_year == tax_year
        ),
        key=lambda citation: citation.key,
    )


def explain_decision(drafter: Drafter, decision: EvalDecision) -> list[Attempt]:
    """One run of the flow, as POST /explain runs it, without the database."""
    name = decision.calculator
    citations = seed_citations(decision.tax_year, name)
    passages = [
        BenefitsPassage(document_id=EVAL_USER, chunk_index=index, text=text, rank=1.0)
        for index, text in enumerate(decision.benefits_passages)
    ]
    setup = explain_setup(
        name,
        decision.inputs,
        decision.result,
        citations,
        passages,
        pay_stub_pct=decision.pay_stub_pct,
    )
    return run_explain(
        drafter,
        EVAL_USER,
        setup.context,
        setup.allowed_numbers,
        setup.citation_keys,
        setup.fallback,
    )


# The claim issue 132's explanation made (spec 008 rule 24): the person as the
# subject, already putting in or getting something ("You are already
# contributing 5%", "You're already at 5%", "you already put 5% in"), or the
# rate chosen called "already in effect". A rate as the subject is a statement
# about the rate, true at any stub ("The 5% you chose already earns the full
# match", "The 4% your pay stub shows already earns the full match").
_MONEY_VERBS = (
    "contribut|put|sav|earn|get|got|receiv|captur|collect|pay|paid|tak|deposit|hav|enrol|maxim"
)
PERSON_ALREADY = re.compile(
    rf"\byou(?:'re|'ve|\s+are|\s+have)?\s+already\s+(?:(?:at|in|on)\b|(?:{_MONEY_VERBS})\w*)",
    re.IGNORECASE,
)
CHOSEN_IN_EFFECT = re.compile(r"\bchos(?:e|en)\b.*\balready\s+in\s+effect\b", re.IGNORECASE)


# Sentences split where ., ! or ? meets whitespace, so "$3,800.00" stays whole.
_SENTENCE_BREAK = re.compile(r"(?<=[.!?])\s+")


def rate_claim(draft: ExplanationDraft) -> str | None:
    """The first sentence in which the draft says the person already puts in or
    gets something, or calls the rate chosen already in effect; None if none does."""
    for text in [draft.concept, draft.text, *draft.what_ifs]:
        for sentence in _SENTENCE_BREAK.split(text):
            if PERSON_ALREADY.search(sentence) or CHOSEN_IN_EFFECT.search(sentence):
                return sentence.strip()
    return None


def claims_rate_in_effect(draft: ExplanationDraft) -> bool:
    """Whether the draft's words say the person already puts in or gets something."""
    return rate_claim(draft) is not None


def frames_rate_scored(decision: EvalDecision) -> bool:
    """Whether ``rate_framing`` counts the decision: a 401(k) decision whose stub
    shows another rate, or no stub."""
    if decision.calculator != CALCULATOR:
        return False
    chosen = Decimal(str(decision.inputs["contribution_pct"]))
    return stub_rate(chosen, decision.pay_stub_pct) is not StubRate.CHOSEN


def score(decisions: Sequence[EvalDecision], drafter: Drafter) -> SuiteResult:
    first_try = fallbacks = cited = framed = scored = 0
    failures: list[str] = []
    for decision in decisions:
        attempts = explain_decision(drafter, decision)
        final = attempts[-1]
        first_try += attempts[0].verified
        fallbacks += final.fallback
        cited += bool(final.draft.citation_keys)
        if frames_rate_scored(decision):
            scored += 1
            claim = rate_claim(final.draft)
            if claim is None:
                framed += 1
            else:
                failures.append(f"{decision.id}: claims the chosen rate is in effect: {claim!r}")
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
            "rate_framing": framed / scored if scored else 1.0,
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
