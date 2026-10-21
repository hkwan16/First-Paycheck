"""The explain-smoke suite (free, spec 008 rule 25): the explain flow with a
scripted ``FakeGateway`` over three scenarios.

Each scenario scripts the model's drafts for the first fixture decision and
states the rows the flow must produce: verified on the first try, a failing
draft then a verified one, and two failing drafts then the fallback.
``flow_correct`` is the share of scenarios whose rows (count, ``attempt``,
``retries``, ``verified``, ``fallback``) match, whose fallback (when there is
one) verifies and is cited, and whose retry carried the first failure. No
database, no API key, no cost.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass

from app.config import Settings
from evals.suites.base import Budget, Suite, SuiteResult
from evals.suites.explain import EvalDecision, explain_decision, load_decisions
from llm.gateway import MemoryLedger, ScriptedGateway, ScriptStep, reply_with
from llm.schemas import ExplanationDraft

Row = tuple[int, int, bool, bool]

# A draft with a number the decision never produced.
BAD = reply_with(
    ExplanationDraft(
        concept="Your employer's match.",
        text="Raising your rate would add $123,456.78 a year.",
        numbers=[],
        what_ifs=[],
        citation_keys=["k401.employer_match"],
    )
)
# FakeGateway's own draft: the facts as given, citing the first key. It verifies.
GOOD: ScriptStep = None


@dataclass(frozen=True)
class Scenario:
    name: str
    script: tuple[ScriptStep, ...]
    # (attempt, retries, verified, fallback) per row.
    expected: tuple[Row, ...]


SCENARIOS = (
    Scenario("pass", (GOOD,), ((1, 0, True, False),)),
    Scenario("fail-then-pass", (BAD, GOOD), ((1, 0, False, False), (2, 1, True, False))),
    Scenario(
        "fail-twice",
        (BAD, BAD),
        ((1, 0, False, False), (2, 1, False, False), (3, 1, False, True)),
    ),
)


def check(scenario: Scenario, decision: EvalDecision) -> list[str]:
    """What the scenario got wrong; empty when the flow ran as expected."""
    gateway = ScriptedGateway(
        Settings(_env_file=None, llm_fake=True), script=scenario.script, ledger=MemoryLedger()
    )
    attempts = explain_decision(gateway, decision)
    problems = []
    rows = tuple((a.attempt, a.retries, a.verified, a.fallback) for a in attempts)
    if rows != scenario.expected:
        problems.append(f"rows {rows}, expected {scenario.expected}")
    final = attempts[-1]
    if final.fallback and not (final.verification.passed and final.draft.citation_keys):
        problems.append(f"the fallback does not verify: {final.verification.feedback()}")
    if len(gateway.contents) > 1:
        retry = json.loads(str(gateway.contents[1]))
        if "$123,456.78" not in retry.get("feedback", ""):
            problems.append("the retry did not carry the first draft's failure")
    return problems


def score(decisions: Sequence[EvalDecision], scenarios: Sequence[Scenario]) -> SuiteResult:
    decision = decisions[0]
    failures = [
        f"{scenario.name}: {problem}"
        for scenario in scenarios
        for problem in check(scenario, decision)
    ]
    failed = {failure.split(":", 1)[0] for failure in failures}
    correct = sum(scenario.name not in failed for scenario in scenarios)
    return SuiteResult(
        metrics={"flow_correct": correct / len(scenarios)},
        cases=len(scenarios),
        failures=failures,
    )


def run(budget: Budget) -> SuiteResult:
    return score(load_decisions(), SCENARIOS)


SUITE = Suite(name="explain-smoke", llm=False, run=run)
