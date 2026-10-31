"""The explain-w4 suite (LLM, spec 008 rules 24c to 24e): the real draft-verify-retry
flow and model over 12 synthetic W-4 decisions.

Each decision in ``evals/fixtures/explain/w4_decisions.json`` is a ``w4`` input and
what its pay stub withholds each paycheck (``pay_stub_withholding_cents``, null for
none; spec 008 rule 7b); six withhold another amount than the entries (issue 181's
decision among them), three what the entries give, three have no stub. Results,
citations and the flow are the explain suite's (``evals/suites/explain.py``).

Metrics (higher is better; each tolerates one case's worth or 2 points, whichever
is larger, as evals/CLAUDE.md says):

- ``first_try_verified``, ``no_fallback``, ``cited``: as in the explain suite.
- ``withholding_framing``: over the decisions whose stub does not withhold what the
  entries give (another amount, or no stub), the share whose final row does not
  claim the entries' withholding or their projection is what happens now (issue
  181), as an LLM judge (``Gateway.judge_withholding_claim``, rule 24d) reads it.
  It measures drafts and never gates one.
- ``judge_accuracy``: the share of the hand-labeled items in
  ``fixtures/explain/withholding_claims.json`` the judge reads as labeled (rule 24e).
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Protocol

from app.config import Settings
from calc.pay_stub import StubWithholding, stub_withholding
from calc.w4 import W4Input, W4Result, at_withholding
from evals.suites.base import Budget, Suite, SuiteResult, SuiteUnavailable
from evals.suites.explain import (
    EVAL_USER,
    UNCAPPED_DAILY_CENTS,
    W4_FIXTURES,
    EvalDecision,
    explain_decision,
    flow_failures,
    load_decisions,
)
from llm.gateway import (
    MICROCENTS_PER_CENT,
    Gateway,
    LedgerEntry,
    LLMError,
    LLMGateway,
    MemoryLedger,
)
from llm.schemas import (
    ExplanationDraft,
    RateClaimDraft,
    WithholdingClaimRequest,
    WithholdingClaimVerdict,
)
from verify.flow import Drafter
from verify.format import dollars

# The withholding-claim judge's calibration items (spec 008 rule 24e).
WITHHOLDING_CLAIMS = W4_FIXTURES.with_name("withholding_claims.json")


def load_w4_decisions(path: Path = W4_FIXTURES) -> list[EvalDecision]:
    return load_decisions(path)


class WithholdingJudge(Protocol):
    """What ``withholding_framing`` and ``judge_accuracy`` ask (spec 008 rule 24d); the
    gateway is one, and tests script others."""

    def judge_withholding_claim(
        self, user_id: uuid.UUID, request: WithholdingClaimRequest
    ) -> WithholdingClaimVerdict: ...


def outcome_words(refund_cents: int) -> str:
    """A refund (positive) or balance due (negative) the way the judge reads it."""
    if refund_cents > 0:
        return f"a refund of {dollars(refund_cents)}"
    if refund_cents < 0:
        return f"a balance due of {dollars(-refund_cents)}"
    return "no refund and nothing due"


def withholding_claim_request(
    entries_cents: int,
    pay_stub_cents: int | None,
    entries_refund_cents: int,
    pay_stub_refund_cents: int | None,
    draft: RateClaimDraft,
) -> WithholdingClaimRequest:
    """The judge's question, with every amount written the way the explain facts write it."""
    return WithholdingClaimRequest(
        entries_withholding=dollars(entries_cents),
        pay_stub_withholding=None if pay_stub_cents is None else dollars(pay_stub_cents),
        entries_outcome=outcome_words(entries_refund_cents),
        pay_stub_outcome=None
        if pay_stub_refund_cents is None
        else outcome_words(pay_stub_refund_cents),
        draft=draft,
    )


@dataclass(frozen=True)
class WithholdingClaimItem:
    """One hand-labeled calibration item for the judge (spec 008 rule 24e)."""

    id: str
    entries_cents: int
    pay_stub_cents: int | None
    entries_refund_cents: int
    pay_stub_refund_cents: int | None
    draft: RateClaimDraft
    # Whether the draft claims the entries are in effect: the expected verdict.
    claims: bool
    # The fixture decision a live sentence was written for, or None for a written one.
    decision: str | None = None

    @property
    def request(self) -> WithholdingClaimRequest:
        return withholding_claim_request(
            self.entries_cents,
            self.pay_stub_cents,
            self.entries_refund_cents,
            self.pay_stub_refund_cents,
            self.draft,
        )


def load_withholding_claims(path: Path = WITHHOLDING_CLAIMS) -> list[WithholdingClaimItem]:
    return [
        WithholdingClaimItem(
            id=entry["id"],
            entries_cents=entry["entries_cents"],
            pay_stub_cents=entry["pay_stub_cents"],
            entries_refund_cents=entry["entries_refund_cents"],
            pay_stub_refund_cents=entry["pay_stub_refund_cents"],
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


def decision_request(decision: EvalDecision, draft: ExplanationDraft) -> WithholdingClaimRequest:
    """What the judge is sent about a decision's final row: both withholdings, both
    outcomes (the stub's from spec 014 rule 10a, as the context states it) and its words."""
    result = W4Result.model_validate(decision.result)
    stub = decision.pay_stub_withholding_cents
    at_stub = (
        None
        if stub is None
        else at_withholding(W4Input.model_validate(decision.inputs), result, stub).refund_cents
    )
    return withholding_claim_request(
        result.withholding_per_paycheck_cents,
        stub,
        result.projected_refund_cents,
        at_stub,
        RateClaimDraft(concept=draft.concept, text=draft.text, what_ifs=list(draft.what_ifs)),
    )


def frames_withholding_scored(decision: EvalDecision) -> bool:
    """Whether ``withholding_framing`` counts the decision: its stub withholds
    another amount than the entries, or there is none (rule 7b)."""
    entries = int(decision.result["withholding_per_paycheck_cents"])
    case = stub_withholding(entries, decision.pay_stub_withholding_cents)
    return case is not StubWithholding.ENTRIES


def judged(
    judge: WithholdingJudge, request: WithholdingClaimRequest
) -> WithholdingClaimVerdict | LLMError:
    """The judge's verdict, or the error it failed with: a failed call counts as a
    miss and the run goes on (spec 008 rule 24d)."""
    try:
        return judge.judge_withholding_claim(EVAL_USER, request)
    except LLMError as exc:
        return exc


def _failed(exc: LLMError) -> str:
    return f"the withholding-claim judge failed: {type(exc).__name__}: {exc}"


def _claim_label(claims: bool) -> str:
    return "a claim" if claims else "no claim"


def calibrate(
    judge: WithholdingJudge, items: Sequence[WithholdingClaimItem]
) -> tuple[int, list[str]]:
    """How many items the judge reads as labeled, and a failure line for each miss."""
    matched = 0
    failures: list[str] = []
    for item in items:
        verdict = judged(judge, item.request)
        if isinstance(verdict, LLMError):
            failures.append(f"judge {item.id}: {_failed(verdict)}")
        elif verdict.claims_entries_in_effect == item.claims:
            matched += 1
        else:
            failures.append(
                f"judge {item.id}: labeled {_claim_label(item.claims)}, judged"
                f" {_claim_label(verdict.claims_entries_in_effect)}:"
                f" {verdict.sentence or item.draft.text!r} ({verdict.reason})"
            )
    return matched, failures


def score(
    decisions: Sequence[EvalDecision],
    drafter: Drafter,
    judge: WithholdingJudge,
    calibration: Sequence[WithholdingClaimItem],
) -> SuiteResult:
    first_try = fallbacks = cited = framed = scored = 0
    failures: list[str] = []
    for decision in decisions:
        attempts = explain_decision(drafter, decision)
        final = attempts[-1]
        first_try += attempts[0].verified
        fallbacks += final.fallback
        cited += bool(final.draft.citation_keys)
        if frames_withholding_scored(decision):
            scored += 1
            verdict = judged(judge, decision_request(decision, final.draft))
            if isinstance(verdict, LLMError):
                failures.append(f"{decision.id}: {_failed(verdict)}")
            elif verdict.claims_entries_in_effect:
                failures.append(
                    f"{decision.id}: claims the entries are in effect: {verdict.sentence!r}"
                )
            else:
                framed += 1
        failures += flow_failures(decision.id, attempts)
    matched, misread = calibrate(judge, calibration)
    count = len(decisions)
    return SuiteResult(
        metrics={
            "first_try_verified": first_try / count if count else 1.0,
            "no_fallback": 1 - fallbacks / count if count else 1.0,
            "cited": cited / count if count else 1.0,
            "withholding_framing": framed / scored if scored else 1.0,
            "judge_accuracy": matched / len(calibration) if calibration else 1.0,
        },
        cases=count,
        failures=[*failures, *misread],
        # One case is one decision; withholding_framing is a share of only the ones
        # it scores, and judge_accuracy a share of the calibration items.
        case_worth={
            "withholding_framing": 1 / scored if scored else 0.0,
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
    result = score(load_w4_decisions(), gateway, gateway, load_withholding_claims())
    return replace(result, cost_cents=sum(spent))


SUITE = Suite(name="explain-w4", llm=True, run=run)
