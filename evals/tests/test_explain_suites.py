"""The explain suite's plumbing and the free explain-smoke suite (spec 008 rules 24-25)."""

from __future__ import annotations

import pytest

from app.config import Settings
from evals.suites import explain, explain_smoke
from evals.suites.base import Budget, SuiteUnavailable
from llm.gateway import FakeGateway, MemoryLedger, ScriptedGateway


def fake() -> FakeGateway:
    return FakeGateway(Settings(_env_file=None, llm_fake=True), ledger=MemoryLedger())


def test_ten_decisions_cover_the_interesting_cases() -> None:
    decisions = explain.load_decisions()
    assert len(decisions) == 10
    assert len({decision.id for decision in decisions}) == 10
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


def test_seed_citations_cover_every_result_key() -> None:
    keys = {citation.key for citation in explain.seed_citations(2026)}
    for decision in explain.load_decisions():
        assert set(decision.result["citation_keys"]) <= keys
    assert explain.seed_citations(2027) == []


def test_fake_drafts_verify_for_every_decision() -> None:
    result = explain.score(explain.load_decisions(), fake())
    assert result.metrics == {"first_try_verified": 1.0, "no_fallback": 1.0, "cited": 1.0}
    assert result.failures == []


def test_failing_drafts_count_as_fallbacks_that_stay_cited() -> None:
    decisions = explain.load_decisions()[:2]
    gateway = ScriptedGateway(
        Settings(_env_file=None, llm_fake=True),
        script=[explain_smoke.BAD] * 4,
        ledger=MemoryLedger(),
    )
    result = explain.score(decisions, gateway)
    assert result.metrics == {"first_try_verified": 0.0, "no_fallback": 0.0, "cited": 1.0}
    assert "tiered-under-match attempt 1: " in result.failures[0]
    assert "$123,456.78" in result.failures[0]
    assert result.failures[2] == "tiered-under-match: fell back after 2 draft(s)"


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
    assert result.metrics == {"first_try_verified": 1.0, "no_fallback": 1.0, "cited": 1.0}


def test_smoke_passes() -> None:
    result = explain_smoke.run(Budget(0))
    assert result.metrics == {"flow_correct": 1.0}
    assert result.cases == 5
    assert {scenario.calculator for scenario in explain_smoke.SCENARIOS} == {"k401_match", "w4"}
    assert result.failures == []
    assert result.cost_cents == 0


def test_smoke_reports_a_flow_that_does_not_match() -> None:
    wrong = explain_smoke.Scenario("wrong", (None,), ((1, 0, False, True),))
    result = explain_smoke.score(explain.load_decisions(), [wrong, explain_smoke.SCENARIOS[0]])
    assert result.metrics == {"flow_correct": 0.5}
    assert result.failures == [
        "wrong: rows ((1, 0, True, False),), expected ((1, 0, False, True),)"
    ]
