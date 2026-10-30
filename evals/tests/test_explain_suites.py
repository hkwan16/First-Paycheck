"""The explain suite's plumbing and the free explain-smoke suite (spec 008 rules 24-25)."""

from __future__ import annotations

import json
import uuid
from decimal import Decimal
from typing import Any

import pytest

from app.config import Settings
from evals.suites import explain, explain_smoke
from evals.suites.base import Budget, SuiteUnavailable
from llm.gateway import FakeGateway, MemoryLedger, ScriptedGateway
from llm.schemas import ExplainContext, ExplanationDraft


def fake() -> FakeGateway:
    return FakeGateway(Settings(_env_file=None, llm_fake=True), ledger=MemoryLedger())


def test_the_decisions_cover_the_interesting_cases() -> None:
    decisions = explain.load_decisions()
    # At least 25, so one flaky draft moves a metric by under 4 points (2 tolerated).
    assert len(decisions) == 29
    assert len({decision.id for decision in decisions}) == 29
    results = [decision.result for decision in decisions]
    assert any(result["capped"] for result in results)
    assert any(result["compensation_capped"] for result in results)
    assert any("k401.catch_up" in result["citation_keys"] for result in results)
    assert any(result["missed_cents"] == 0 for result in results)
    assert any(not decision.inputs["match_tiers"] for decision in decisions)
    assert any(decision.benefits_passages for decision in decisions)
    # Stored form: percentages as two-place strings, money as integer cents.
    assert decisions[0].inputs["contribution_pct"] == "3.00"
    assert decisions[0].result["missed_cents"] == 60_000


def test_the_decisions_cover_the_pay_stub_rate() -> None:
    """Spec 008 rule 24: the rate the stub shows, apart from the rate chosen (issue 132)."""
    decisions = explain.load_decisions()

    def chosen(decision: explain.EvalDecision) -> Decimal:
        return Decimal(decision.inputs["contribution_pct"])

    differs = [d for d in decisions if d.pay_stub_pct is not None and d.pay_stub_pct != chosen(d)]
    same = [d for d in decisions if d.pay_stub_pct is not None and d.pay_stub_pct == chosen(d)]
    assert len(differs) == 14
    assert len(same) == 11
    assert len([d for d in decisions if d.pay_stub_pct is None]) == 4
    # Raised, lowered, from nothing, to nothing, uneven, and over the full match.
    assert any(d.pay_stub_pct < chosen(d) for d in differs if d.pay_stub_pct is not None)
    assert any(d.pay_stub_pct > chosen(d) for d in differs if d.pay_stub_pct is not None)
    assert any(d.pay_stub_pct == 0 for d in differs)
    assert any(chosen(d) == 0 for d in differs)
    assert any(d.pay_stub_pct == Decimal("3.69") for d in differs)
    assert any(d.result["missed_cents"] == 0 for d in differs)
    [issue] = [d for d in decisions if d.id == "issue-132-stub-01-chose-full-match"]
    assert (issue.pay_stub_pct, issue.inputs["contribution_pct"]) == (Decimal("3.00"), "5.00")
    assert issue.inputs["salary_cents"] == 9_500_010
    assert issue.result["missed_cents"] == 0


def test_the_stub_rate_reaches_the_model() -> None:
    [issue] = [d for d in explain.load_decisions() if d.id == "issue-132-stub-01-chose-full-match"]
    gateway = ScriptedGateway(
        Settings(_env_file=None, llm_fake=True), script=[None], ledger=MemoryLedger()
    )
    [attempt] = explain.explain_decision(gateway, issue)
    assert attempt.verified
    sent = json.loads(str(gateway.contents[0]))["context"]
    assert sent["facts"][1] == {
        "label": "401(k) contribution rate your latest pay stub shows",
        "value": "3%",
    }


def test_seed_citations_cover_every_result_key() -> None:
    keys = {citation.key for citation in explain.seed_citations(2026)}
    for decision in explain.load_decisions():
        assert set(decision.result["citation_keys"]) <= keys
    assert explain.seed_citations(2027) == []


def test_fake_drafts_verify_for_every_decision() -> None:
    result = explain.score(explain.load_decisions(), fake())
    assert result.metrics == {
        "first_try_verified": 1.0,
        "no_fallback": 1.0,
        "cited": 1.0,
        "rate_framing": 1.0,
    }
    assert result.failures == []


def test_failing_drafts_count_as_fallbacks_that_stay_cited() -> None:
    decisions = explain.load_decisions()[:2]
    gateway = ScriptedGateway(
        Settings(_env_file=None, llm_fake=True),
        script=[explain_smoke.BAD] * 4,
        ledger=MemoryLedger(),
    )
    result = explain.score(decisions, gateway)
    assert result.metrics == {
        "first_try_verified": 0.0,
        "no_fallback": 0.0,
        "cited": 1.0,
        "rate_framing": 1.0,
    }
    assert "tiered-under-match attempt 1: " in result.failures[0]
    assert "$123,456.78" in result.failures[0]
    assert result.failures[2] == "tiered-under-match: fell back after 2 draft(s)"


# Spec 008 rule 24: rate_framing's heuristic on fixed drafts. The bug's claim
# has the person as its subject; a rate as the subject is a statement about it.
CLAIMS = [
    "You are already contributing 5%, which is the rate that earns the full match.",
    "You are already contributing 5%",
    "You're already at 5%.",
    "You already earn the full match.",
    "you already put 5% in",
    "You've already got the full match.",
    "At 5% you already earn the full match.",
    "The 5% you chose is already in effect.",
]
# Final explanations from the live runs (spec 008 rule 24): all true at any stub.
OBSERVED = [
    "Going from 5% to the full-match rate costs $0.00 extra per paycheck before tax and"
    " $0.00 after federal income tax, using your 32% marginal rate, because the rate you"
    " chose already earns the full match.",
    "The 5% you chose already earns the full match, so the match you miss is $0.00.",
    "The 4% your pay stub shows already earns the full match.",
    "Because the rate you chose already earns the full match, moving to the full-match rate"
    " would cost you an extra $0.00 per paycheck before tax and $0.00 after federal income"
    " tax.",
    "Going from 5% to the full-match rate costs you an extra $0.00 per paycheck before tax"
    " and $0.00 after federal income tax, because the rate already earning the full match is"
    " the one on your pay stub.",
]
NOT_CLAIMS = [
    *OBSERVED,
    "The 5% you chose is already the rate that earns the full match.",
    "You are already choosing the full-match rate.",
    "Your choice already matches the rate that earns the full match.",
    "Already-chosen rates take effect after payroll updates.",
    "The 4% your pay stub shows is already in effect.",
    "Your pay stub shows 3% now. At the 5% you chose, your employer would add $3,800.00 a year.",
]


@pytest.mark.parametrize(
    ("text", "claims"),
    [*((text, True) for text in CLAIMS), *((text, False) for text in NOT_CLAIMS)],
)
def test_claims_rate_in_effect(text: str, claims: bool) -> None:
    draft = ExplanationDraft(concept="c", text=text, numbers=[], what_ifs=[], citation_keys=[])
    assert explain.claims_rate_in_effect(draft) is claims


def test_rate_claim_quotes_its_sentence() -> None:
    draft = ExplanationDraft(
        concept="c",
        text="Your stub shows 3%. You are already at 5% now. That earns the full match.",
        numbers=[],
        what_ifs=[],
        citation_keys=[],
    )
    assert explain.rate_claim(draft) == "You are already at 5% now."
    plain = draft.model_copy(update={"text": "At 5% you would earn the full match."})
    assert explain.rate_claim(plain) is None


def test_the_claim_counts_in_the_concept_and_what_ifs() -> None:
    def draft(**fields: Any) -> ExplanationDraft:
        base: dict[str, Any] = {"concept": "c", "text": "t", "numbers": [], "what_ifs": []}
        return ExplanationDraft(citation_keys=[], **{**base, **fields})

    assert explain.claims_rate_in_effect(draft(concept="You already earn the match."))
    assert explain.claims_rate_in_effect(draft(what_ifs=["You already put in 5%."]))


class Claims:
    """A drafter that always claims the chosen rate is in effect, and verifies:
    no numbers, the first allowed citation."""

    def explain(
        self, user_id: uuid.UUID, context: ExplainContext, *, feedback: str | None = None
    ) -> ExplanationDraft:
        return ExplanationDraft(
            concept="Your employer's match.",
            text="You are already contributing the rate that earns the full match.",
            numbers=[],
            what_ifs=[],
            citation_keys=[context.citations[0].key],
        )


def test_rate_framing_scores_only_a_stub_that_does_not_show_the_chosen_rate() -> None:
    decisions = explain.load_decisions()
    scored = [d for d in decisions if explain.frames_rate_scored(d)]
    assert len(scored) == 18
    result = explain.score(decisions, Claims())
    assert result.metrics["first_try_verified"] == 1.0
    assert result.metrics["rate_framing"] == 0.0
    # The failure quotes the sentence, so a run's report shows which rate it was about.
    claim = (
        "issue-132-stub-01-chose-full-match: claims the chosen rate is in effect:"
        " 'You are already contributing the rate that earns the full match.'"
    )
    assert claim in result.failures
    # The 11 decisions whose stub shows the chosen rate may say so.
    same = [d for d in decisions if not explain.frames_rate_scored(d)]
    assert explain.score(same, Claims()).metrics["rate_framing"] == 1.0


def test_the_live_suite_needs_a_key(monkeypatch: pytest.MonkeyPatch) -> None:
    # Explicitly no key: a key in the shell's environment must not make this a live call.
    no_key = Settings(_env_file=None, anthropic_api_key=None)
    monkeypatch.setattr(explain, "_settings", lambda: no_key)
    with pytest.raises(SuiteUnavailable, match="ANTHROPIC_API_KEY"):
        explain.run(Budget(100))


def test_w4_smoke_decision_is_spec_014_example_9() -> None:
    [decision] = explain.load_decisions(explain.W4_FIXTURES)
    assert decision.calculator == "w4"
    assert decision.result["suggestion"] == "increase_deductions"
    assert decision.result["suggested_deductions_cents"] == 1_068_300
    keys = {citation.key for citation in explain.seed_citations(2026, "w4")}
    assert set(decision.result["citation_keys"]) <= keys
    result = explain.score([decision], fake())
    assert result.metrics == {
        "first_try_verified": 1.0,
        "no_fallback": 1.0,
        "cited": 1.0,
        "rate_framing": 1.0,
    }


def test_smoke_passes() -> None:
    result = explain_smoke.run(Budget(0))
    assert result.metrics == {"flow_correct": 1.0}
    assert result.cases == 6
    assert {scenario.calculator for scenario in explain_smoke.SCENARIOS} == {"k401_match", "w4"}
    assert {scenario.decision_id for scenario in explain_smoke.SCENARIOS} == {
        None,
        "issue-132-stub-01-chose-full-match",
    }
    assert result.failures == []
    assert result.cost_cents == 0


def test_smoke_reports_a_flow_that_does_not_match() -> None:
    wrong = explain_smoke.Scenario("wrong", (None,), ((1, 0, False, True),))
    result = explain_smoke.score(explain.load_decisions(), [wrong, explain_smoke.SCENARIOS[0]])
    assert result.metrics == {"flow_correct": 0.5}
    assert result.failures == [
        "wrong: rows ((1, 0, True, False),), expected ((1, 0, False, True),)"
    ]
