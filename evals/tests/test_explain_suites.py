"""The explain suite's plumbing and the free explain-smoke suite (spec 008 rules 24-25)."""

from __future__ import annotations

import json
import re
import uuid
from decimal import Decimal
from pathlib import Path

import pytest
from pydantic import SecretStr

from app.config import Settings
from evals.suites import explain, explain_smoke
from evals.suites.base import Budget, SuiteUnavailable
from llm.gateway import (
    JUDGE_RATE_CLAIM_PROMPT,
    FakeGateway,
    LLMUnavailable,
    MemoryLedger,
    ScriptedGateway,
)
from llm.prompts import load_prompt
from llm.schemas import (
    ExplainContext,
    ExplanationDraft,
    RateClaimDraft,
    RateClaimRequest,
    RateClaimVerdict,
)

ISSUE_132 = "issue-132-stub-01-chose-full-match"


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


NO_CALIBRATION: list[explain.RateClaimItem] = []
SPEC_008 = Path(__file__).resolve().parents[2] / "docs" / "specs" / "008-explain-and-verify.md"


def test_fake_drafts_verify_for_every_decision() -> None:
    result = explain.score(explain.load_decisions(), fake(), fake(), NO_CALIBRATION)
    assert result.metrics == {
        "first_try_verified": 1.0,
        "no_fallback": 1.0,
        "cited": 1.0,
        "rate_framing": 1.0,
        "judge_accuracy": 1.0,
    }
    assert result.failures == []


def test_failing_drafts_count_as_fallbacks_that_stay_cited() -> None:
    decisions = explain.load_decisions()[:2]
    gateway = ScriptedGateway(
        Settings(_env_file=None, llm_fake=True),
        script=[explain_smoke.BAD] * 4,
        ledger=MemoryLedger(),
    )
    result = explain.score(decisions, gateway, fake(), NO_CALIBRATION)
    assert result.metrics == {
        "first_try_verified": 0.0,
        "no_fallback": 0.0,
        "cited": 1.0,
        "rate_framing": 1.0,
        "judge_accuracy": 1.0,
    }
    assert "tiered-under-match attempt 1: " in result.failures[0]
    assert "$123,456.78" in result.failures[0]
    assert result.failures[2] == "tiered-under-match: fell back after 2 draft(s)"


# Spec 008 rules 24 and 24a: rate_framing is the judge's verdict on each scored
# decision's final row. These judges are scripted; the live suite asks the model.

CLAIM = "You are already contributing the rate that earns the full match."


class Claims:
    """A drafter that always claims the chosen rate is in effect, and verifies:
    no numbers, the first allowed citation."""

    def explain(
        self, user_id: uuid.UUID, context: ExplainContext, *, feedback: str | None = None
    ) -> ExplanationDraft:
        return ExplanationDraft(
            concept="Your employer's match.",
            text=f"{CLAIM} Your employer adds money to it.",
            numbers=[],
            what_ifs=[],
            citation_keys=[context.citations[0].key],
        )


class FlagsSentences:
    """A scripted judge: it flags the first of ``flagged`` found in the draft's
    concept, text or what-ifs, and keeps every request it was sent."""

    def __init__(self, *flagged: str) -> None:
        self.flagged = flagged
        self.requests: list[RateClaimRequest] = []

    def judge_rate_claim(self, user_id: uuid.UUID, request: RateClaimRequest) -> RateClaimVerdict:
        self.requests.append(request)
        parts = [request.draft.concept, request.draft.text, *request.draft.what_ifs]
        for sentence in self.flagged:
            if any(sentence in part for part in parts):
                return RateClaimVerdict(
                    reason="scripted", claims_chosen_rate_in_effect=True, sentence=sentence
                )
        return RateClaimVerdict(reason="scripted", claims_chosen_rate_in_effect=False)


class AnswersFromLabels:
    """A scripted judge that answers each calibration item with its label, except
    the items named in ``wrong``, which it answers the other way."""

    def __init__(self, items: list[explain.RateClaimItem], *wrong: str) -> None:
        self.labels = {item.request.model_dump_json(): item for item in items}
        self.wrong = set(wrong)

    def judge_rate_claim(self, user_id: uuid.UUID, request: RateClaimRequest) -> RateClaimVerdict:
        item = self.labels[request.model_dump_json()]
        claims = item.claims != (item.id in self.wrong)
        return RateClaimVerdict(
            reason=f"scripted for {item.id}",
            claims_chosen_rate_in_effect=claims,
            sentence=item.draft.text if claims else None,
        )


class Fails:
    def judge_rate_claim(self, user_id: uuid.UUID, request: RateClaimRequest) -> RateClaimVerdict:
        raise LLMUnavailable("Anthropic API returned HTTP 529 (InternalServerError)")


def test_rate_framing_is_the_judges_verdict_on_the_scored_decisions() -> None:
    decisions = explain.load_decisions()
    scored = [d for d in decisions if explain.frames_rate_scored(d)]
    assert len(scored) == 18
    judge = FlagsSentences(CLAIM)
    result = explain.score(decisions, Claims(), judge, NO_CALIBRATION)
    assert result.metrics["first_try_verified"] == 1.0
    assert result.metrics["rate_framing"] == 0.0
    # The judge reads only the 18 scored decisions, each with its own rates.
    assert len(judge.requests) == 18
    [issue] = [r for r, d in zip(judge.requests, scored, strict=True) if d.id == ISSUE_132]
    assert (issue.chosen_rate, issue.pay_stub_rate, issue.full_match_rate) == ("5%", "3%", "5%")
    assert issue.draft == RateClaimDraft(
        concept="Your employer's match.",
        text=f"{CLAIM} Your employer adds money to it.",
        what_ifs=[],
    )
    # The failure quotes the judge's sentence, so a run's report shows which rate it was about.
    assert f"{ISSUE_132}: claims the chosen rate is in effect: {CLAIM!r}" in result.failures
    # The 11 decisions whose stub shows the chosen rate may say so, and are never judged.
    same = [d for d in decisions if not explain.frames_rate_scored(d)]
    unscored = FlagsSentences(CLAIM)
    assert explain.score(same, Claims(), unscored, NO_CALIBRATION).metrics["rate_framing"] == 1.0
    assert unscored.requests == []


def test_a_draft_the_judge_finds_no_claim_in_is_framed() -> None:
    decisions = explain.load_decisions()
    result = explain.score(decisions, Claims(), FlagsSentences(), NO_CALIBRATION)
    assert result.metrics["rate_framing"] == 1.0
    assert result.failures == []


def test_the_judge_reads_the_final_row() -> None:
    """A run that falls back is judged on the fallback's words (spec 008 rule 24)."""
    [issue] = [d for d in explain.load_decisions() if d.id == ISSUE_132]
    attempts = explain.explain_decision(
        ScriptedGateway(
            Settings(_env_file=None, llm_fake=True),
            script=[explain_smoke.BAD] * 2,
            ledger=MemoryLedger(),
        ),
        issue,
    )
    assert attempts[-1].fallback
    judge = FlagsSentences()
    drafter = ScriptedGateway(
        Settings(_env_file=None, llm_fake=True),
        script=[explain_smoke.BAD] * 2,
        ledger=MemoryLedger(),
    )
    explain.score([issue], drafter, judge, NO_CALIBRATION)
    [request] = judge.requests
    assert request.draft.text == attempts[-1].draft.text
    assert request.draft.concept == attempts[-1].draft.concept


def test_the_request_names_no_stub_and_no_match_as_null() -> None:
    by_id = {d.id: d for d in explain.load_decisions()}
    draft = ExplanationDraft(concept="c", text="t", numbers=[], what_ifs=["w"], citation_keys=[])
    no_stub = explain.decision_request(by_id["catch-up-61"], draft)
    assert (no_stub.chosen_rate, no_stub.pay_stub_rate, no_stub.full_match_rate) == (
        "12%",
        None,
        "5%",
    )
    assert no_stub.draft == RateClaimDraft(concept="c", text="t", what_ifs=["w"])
    no_match = explain.decision_request(by_id["no-match-stub-differs"], draft)
    assert (no_match.chosen_rate, no_match.pay_stub_rate, no_match.full_match_rate) == (
        "6%",
        "3%",
        None,
    )
    uneven = explain.decision_request(by_id["uneven-stub-rate"], draft)
    assert (uneven.chosen_rate, uneven.pay_stub_rate, uneven.full_match_rate) == (
        "4%",
        "3.69%",
        "4%",
    )


def test_a_judge_error_counts_as_a_miss_and_does_not_stop_the_run() -> None:
    decisions = explain.load_decisions()
    items = explain.load_rate_claims()[:2]
    result = explain.score(decisions, fake(), Fails(), items)
    assert result.metrics["rate_framing"] == 0.0
    assert result.metrics["judge_accuracy"] == 0.0
    assert result.metrics["first_try_verified"] == 1.0
    assert (
        f"{ISSUE_132}: the rate-claim judge failed:"
        " LLMUnavailable: Anthropic API returned HTTP 529 (InternalServerError)"
    ) in result.failures
    assert any(line.startswith(f"judge {items[0].id}: ") for line in result.failures)


# Spec 008 rule 24b: the judge's own calibration over hand-labeled items.


def test_the_calibration_items_cover_the_cases() -> None:
    items = explain.load_rate_claims()
    assert len({item.id for item in items}) == len(items)
    claims = [item for item in items if item.claims]
    assert len(claims) >= 8
    assert len(items) - len(claims) >= 12
    assert any(item.pay_stub_pct is None for item in claims)
    assert any(item.pay_stub_pct is None for item in items if not item.claims)
    assert any(item.pay_stub_pct == item.chosen_pct for item in claims)
    assert any(item.full_match_pct is None for item in items)
    assert any("If you stay at" in item.draft.text for item in items if not item.claims)
    assert any(claim.draft.what_ifs and "already" in claim.draft.what_ifs[0] for claim in claims)
    assert any("already" in claim.draft.concept for claim in claims)
    # Live sentences carry the rates of the fixture decision they came from.
    decisions = {d.id: d for d in explain.load_decisions()}
    live = [item for item in items if item.decision is not None]
    assert len(live) == 7
    for item in live:
        decision = decisions[item.decision or ""]
        assert item.chosen_pct == Decimal(decision.inputs["contribution_pct"]), item.id
        assert item.pay_stub_pct == decision.pay_stub_pct, item.id
        assert item.full_match_pct == explain.full_match_pct(decision), item.id
        assert not item.claims, item.id


def test_the_judge_prompt_does_not_quote_the_calibration_items() -> None:
    """judge_accuracy measures how the judge reads, not what it was shown."""
    system = load_prompt(*JUDGE_RATE_CLAIM_PROMPT).system
    for item in explain.load_rate_claims():
        for part in (item.draft.concept, item.draft.text, *item.draft.what_ifs):
            assert not part or part not in system, item.id


def _spec_rows() -> list[tuple[str | None, str | None, str | None, str, bool]]:
    text = SPEC_008.read_text()
    start = text.index("### Rate framing")
    section = text[start : text.index("\n### ", start + 1)]
    rows = re.findall(
        r"^\| (\S+) \| (\S+) \| (\S+) \| `(.+?)`.* \| (yes|no) \|$", section, flags=re.MULTILINE
    )
    return [
        (
            *(None if rate == "none" else rate for rate in (chosen, stub, full)),
            sentence,
            label == "yes",
        )
        for chosen, stub, full, sentence, label in rows
    ]


def test_every_spec_rate_framing_row_is_an_item() -> None:
    rows = _spec_rows()
    assert len(rows) == 19
    items: dict[tuple[str | None, str | None, str | None, str], bool] = {
        (
            item.request.chosen_rate,
            item.request.pay_stub_rate,
            item.request.full_match_rate,
            item.draft.text,
        ): item.claims
        for item in explain.load_rate_claims()
    }
    for chosen, stub, full, sentence, claims in rows:
        assert items.get((chosen, stub, full, sentence)) is claims, sentence


def test_judge_accuracy_is_the_share_of_labels_the_judge_matches() -> None:
    items = explain.load_rate_claims()
    decisions = explain.load_decisions()[:1]
    exact = explain.score(decisions, fake(), AnswersFromLabels(items), items)
    assert exact.metrics["judge_accuracy"] == 1.0
    assert exact.failures == []
    miss = "live-stay-at-stub"
    one_wrong = explain.score(decisions, fake(), AnswersFromLabels(items, miss), items)
    assert one_wrong.metrics["judge_accuracy"] == pytest.approx((len(items) - 1) / len(items))
    [line] = one_wrong.failures
    assert line.startswith(f"judge {miss}: labeled no claim, judged a claim: ")
    assert "If you stay at the 4% on your pay stub" in line
    # FakeGateway reads no claim anywhere, so it matches only the items that make none.
    free = explain.score(decisions, fake(), fake(), items)
    assert free.metrics["judge_accuracy"] == pytest.approx(
        sum(not item.claims for item in items) / len(items)
    )


def test_one_case_is_a_decision_and_the_judged_metrics_count_only_their_own() -> None:
    """evals/CLAUDE.md: a metric tolerates one case's worth. rate_framing is a
    share of the 18 decisions it scores, not of all 29, so one is worth 1/18;
    judge_accuracy is a share of the calibration items."""
    items = explain.load_rate_claims()
    result = explain.score(explain.load_decisions(), fake(), fake(), items)
    assert result.cases == 29
    assert result.case_worth == {
        "rate_framing": pytest.approx(1 / 18),
        "judge_accuracy": pytest.approx(1 / len(items)),
    }


def test_the_live_suite_needs_a_key(monkeypatch: pytest.MonkeyPatch) -> None:
    # Explicitly no key: a key in the shell's environment must not make this a live call.
    no_key = Settings(_env_file=None, anthropic_api_key=None)
    monkeypatch.setattr(explain, "_settings", lambda: no_key)
    with pytest.raises(SuiteUnavailable, match="ANTHROPIC_API_KEY"):
        explain.run(Budget(100))


def test_the_live_suite_drafts_and_judges_through_one_gateway(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """run() wires the gateway in as both drafter and judge, over the calibration
    items, and charges its ledger; FakeGateway stands in for the model here."""
    settings = Settings(_env_file=None, anthropic_api_key=SecretStr("sk-ant-test"))
    monkeypatch.setattr(explain, "_settings", lambda: settings)
    ledgers: list[MemoryLedger] = []

    def gateway(settings: Settings, ledger: MemoryLedger) -> FakeGateway:
        ledgers.append(ledger)
        return FakeGateway(settings, ledger=ledger)

    monkeypatch.setattr(explain, "_gateway", gateway)
    result = explain.run(Budget(0))
    items = explain.load_rate_claims()
    assert result.metrics["first_try_verified"] == 1.0
    assert result.metrics["judge_accuracy"] == pytest.approx(
        sum(not item.claims for item in items) / len(items)
    )
    assert result.case_worth["judge_accuracy"] == pytest.approx(1 / len(items))
    assert result.cost_cents == 0
    [ledger] = ledgers
    versions = [entry.prompt_version for entry in ledger.entries]
    assert versions.count("explain/v3") == 29
    assert versions.count("judge_rate_claim/v1") == 18 + len(items)


def test_w4_smoke_decision_is_spec_014_example_9() -> None:
    """The smoke suite's W-4 pass and fail-twice explain the first W-4 decision."""
    decision = explain.load_decisions(explain.W4_FIXTURES)[0]
    assert decision.calculator == "w4"
    assert decision.pay_stub_withholding_cents is None
    assert decision.result["suggestion"] == "increase_deductions"
    assert decision.result["suggested_deductions_cents"] == 1_068_300
    keys = {citation.key for citation in explain.seed_citations(2026, "w4")}
    assert set(decision.result["citation_keys"]) <= keys
    result = explain.score([decision], fake(), fake(), NO_CALIBRATION)
    assert result.metrics == {
        "first_try_verified": 1.0,
        "no_fallback": 1.0,
        "cited": 1.0,
        "rate_framing": 1.0,
        "judge_accuracy": 1.0,
    }


def test_smoke_passes() -> None:
    result = explain_smoke.run(Budget(0))
    assert result.metrics == {"flow_correct": 1.0}
    assert result.cases == 8
    assert {scenario.calculator for scenario in explain_smoke.SCENARIOS} == {"k401_match", "w4"}
    assert {scenario.decision_id for scenario in explain_smoke.SCENARIOS} == {
        None,
        "issue-132-stub-01-chose-full-match",
        "issue-181-stub-01",
    }
    assert result.failures == []
    assert result.cost_cents == 0


def test_smoke_w4_fallback_states_the_stub_withholding() -> None:
    """Spec 008 rule 7b: issue 181's fallback says what the stub withholds now."""
    decisions = explain.load_decisions(explain.W4_FIXTURES)
    [scenario] = [s for s in explain_smoke.SCENARIOS if s.name == "w4-stub-differs-fail-twice"]
    [decision] = [d for d in decisions if d.id == scenario.decision_id]
    gateway = ScriptedGateway(
        Settings(_env_file=None, llm_fake=True), script=scenario.script, ledger=MemoryLedger()
    )
    final = explain.explain_decision(gateway, decision)[-1]
    assert final.fallback
    assert "Your latest pay stub withholds $272.44 a paycheck now." in final.draft.text
    assert "you would owe about $3,918.70" in final.draft.text


def test_smoke_reports_a_flow_that_does_not_match() -> None:
    wrong = explain_smoke.Scenario("wrong", (None,), ((1, 0, False, True),))
    result = explain_smoke.score(explain.load_decisions(), [wrong, explain_smoke.SCENARIOS[0]])
    assert result.metrics == {"flow_correct": 0.5}
    assert result.failures == [
        "wrong: rows ((1, 0, True, False),), expected ((1, 0, False, True),)"
    ]
