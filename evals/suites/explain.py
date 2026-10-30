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
  claim the chosen rate is already in effect (issue 132), as an LLM judge
  (``Gateway.judge_rate_claim``, spec 008 rule 24a) reads it. It measures
  drafts and never gates one.
- ``judge_accuracy``: the share of the hand-labeled items in
  ``fixtures/explain/rate_claims.json`` the judge reads as labeled (rule 24b),
  so a run shows whether a low ``rate_framing`` is the drafts or the judge.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, replace
from decimal import Decimal
from pathlib import Path
from typing import Any, Protocol

from app.config import Settings
from calc.pay_stub import StubRate, stub_rate
from calc.registry import calculator as registered_calculator
from db.seed.load import read_seed_citations
from evals.suites.base import Budget, Suite, SuiteResult, SuiteUnavailable
from llm.gateway import (
    MICROCENTS_PER_CENT,
    Gateway,
    LedgerEntry,
    LLMError,
    LLMGateway,
    MemoryLedger,
)
from llm.schemas import ExplanationDraft, RateClaimDraft, RateClaimRequest, RateClaimVerdict
from retrieval.benefits_search import BenefitsPassage
from retrieval.citations import Citation
from retrieval.context import explain_setup
from verify.flow import Attempt, Drafter, run_explain
from verify.format import percent

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "explain" / "decisions.json"
# The explain-smoke suite's W-4 decision (spec 014 rule 19); the live suite stays on
# the 401(k) decisions.
W4_FIXTURES = FIXTURES.with_name("w4_decisions.json")
# The rate-claim judge's calibration items (spec 008 rule 24b).
RATE_CLAIMS = FIXTURES.with_name("rate_claims.json")
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


class RateJudge(Protocol):
    """What ``rate_framing`` and ``judge_accuracy`` ask (spec 008 rule 24a); the
    gateway is one, and tests script others."""

    def judge_rate_claim(
        self, user_id: uuid.UUID, request: RateClaimRequest
    ) -> RateClaimVerdict: ...


@dataclass(frozen=True)
class RateClaimItem:
    """One hand-labeled calibration item for the judge (spec 008 rule 24b)."""

    id: str
    chosen_pct: Decimal
    pay_stub_pct: Decimal | None
    full_match_pct: Decimal | None
    draft: RateClaimDraft
    # Whether the draft claims the chosen rate is in effect: the expected verdict.
    claims: bool
    # The fixture decision a live sentence came from, or None for a written one.
    decision: str | None = None

    @property
    def request(self) -> RateClaimRequest:
        return rate_claim_request(
            self.chosen_pct, self.pay_stub_pct, self.full_match_pct, self.draft
        )


def load_rate_claims(path: Path = RATE_CLAIMS) -> list[RateClaimItem]:
    return [
        RateClaimItem(
            id=entry["id"],
            chosen_pct=Decimal(entry["chosen_pct"]),
            pay_stub_pct=_rate(entry["pay_stub_pct"]),
            full_match_pct=_rate(entry["full_match_pct"]),
            draft=RateClaimDraft(
                concept=entry.get("concept", ""),
                text=entry["text"],
                what_ifs=entry.get("what_ifs", []),
            ),
            claims=entry["claims"],
            decision=entry.get("decision"),
        )
        for entry in json.loads(path.read_text())
    ]


def rate_claim_request(
    chosen_pct: Decimal,
    pay_stub_pct: Decimal | None,
    full_match_pct: Decimal | None,
    draft: RateClaimDraft,
) -> RateClaimRequest:
    """The judge's question, with every rate written the way the explain facts write it."""
    return RateClaimRequest(
        chosen_rate=percent(chosen_pct),
        pay_stub_rate=None if pay_stub_pct is None else percent(pay_stub_pct),
        full_match_rate=None if full_match_pct is None else percent(full_match_pct),
        draft=draft,
    )


def full_match_pct(decision: EvalDecision) -> Decimal | None:
    """The rate that earns the whole match, or None for a plan with no match."""
    if not decision.inputs["match_tiers"]:
        return None
    return Decimal(str(decision.result["full_match_pct"]))


def decision_request(decision: EvalDecision, draft: ExplanationDraft) -> RateClaimRequest:
    """What the judge is sent about a decision's final row: its rates and its words."""
    return rate_claim_request(
        Decimal(str(decision.inputs["contribution_pct"])),
        decision.pay_stub_pct,
        full_match_pct(decision),
        RateClaimDraft(concept=draft.concept, text=draft.text, what_ifs=list(draft.what_ifs)),
    )


def judged(judge: RateJudge, request: RateClaimRequest) -> RateClaimVerdict | LLMError:
    """The judge's verdict, or the error it failed with: a failed call counts as
    a miss and the run goes on (spec 008 rule 24a)."""
    try:
        return judge.judge_rate_claim(EVAL_USER, request)
    except LLMError as exc:
        return exc


def _failed(exc: LLMError) -> str:
    return f"the rate-claim judge failed: {type(exc).__name__}: {exc}"


def frames_rate_scored(decision: EvalDecision) -> bool:
    """Whether ``rate_framing`` counts the decision: a 401(k) decision whose stub
    shows another rate, or no stub."""
    if decision.calculator != CALCULATOR:
        return False
    chosen = Decimal(str(decision.inputs["contribution_pct"]))
    return stub_rate(chosen, decision.pay_stub_pct) is not StubRate.CHOSEN


def _claim_label(claims: bool) -> str:
    return "a claim" if claims else "no claim"


def calibrate(judge: RateJudge, items: Sequence[RateClaimItem]) -> tuple[int, list[str]]:
    """How many items the judge reads as labeled, and a failure line for each miss."""
    matched = 0
    failures: list[str] = []
    for item in items:
        verdict = judged(judge, item.request)
        if isinstance(verdict, LLMError):
            failures.append(f"judge {item.id}: {_failed(verdict)}")
        elif verdict.claims_chosen_rate_in_effect == item.claims:
            matched += 1
        else:
            failures.append(
                f"judge {item.id}: labeled {_claim_label(item.claims)}, judged"
                f" {_claim_label(verdict.claims_chosen_rate_in_effect)}:"
                f" {verdict.sentence or item.draft.text!r} ({verdict.reason})"
            )
    return matched, failures


def score(
    decisions: Sequence[EvalDecision],
    drafter: Drafter,
    judge: RateJudge,
    calibration: Sequence[RateClaimItem],
) -> SuiteResult:
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
            verdict = judged(judge, decision_request(decision, final.draft))
            if isinstance(verdict, LLMError):
                failures.append(f"{decision.id}: {_failed(verdict)}")
            elif verdict.claims_chosen_rate_in_effect:
                failures.append(
                    f"{decision.id}: claims the chosen rate is in effect: {verdict.sentence!r}"
                )
            else:
                framed += 1
        for attempt in attempts:
            if not attempt.fallback and not attempt.verified:
                failures.append(
                    f"{decision.id} attempt {attempt.attempt}: "
                    + attempt.verification.feedback().replace("\n", "; ")
                )
        if final.fallback:
            failures.append(f"{decision.id}: fell back after {len(attempts) - 1} draft(s)")
    matched, misread = calibrate(judge, calibration)
    count = len(decisions)
    return SuiteResult(
        metrics={
            "first_try_verified": first_try / count if count else 1.0,
            "no_fallback": 1 - fallbacks / count if count else 1.0,
            "cited": cited / count if count else 1.0,
            "rate_framing": framed / scored if scored else 1.0,
            "judge_accuracy": matched / len(calibration) if calibration else 1.0,
        },
        cases=count,
        failures=[*failures, *misread],
        # One case is one decision; rate_framing is a share of only the ones it
        # scores, and judge_accuracy a share of the calibration items.
        case_worth={
            "rate_framing": 1 / scored if scored else 0.0,
            "judge_accuracy": 1 / len(calibration) if calibration else 0.0,
        },
    )


def _settings() -> Settings:
    return Settings()


def _gateway(settings: Settings, ledger: MemoryLedger) -> Gateway:
    return LLMGateway(settings, ledger=ledger)


def run(budget: Budget) -> SuiteResult:
    settings = _settings()
    if settings.anthropic_api_key is None:
        raise SuiteUnavailable("ANTHROPIC_API_KEY is not set")
    spent: list[float] = []

    def charge(entry: LedgerEntry) -> None:
        cents = entry.cost_microcents / MICROCENTS_PER_CENT
        spent.append(cents)
        budget.charge(cents)

    gateway = _gateway(
        settings.model_copy(
            update={"llm_fake": False, "llm_daily_budget_cents": UNCAPPED_DAILY_CENTS}
        ),
        MemoryLedger(on_record=charge),
    )
    # One gateway drafts and judges, so both are charged to the run's budget.
    result = score(load_decisions(), gateway, gateway, load_rate_claims())
    return replace(result, cost_cents=sum(spent))


SUITE = Suite(name="explain", llm=True, run=run)
