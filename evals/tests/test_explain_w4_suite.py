"""The explain-w4 suite's plumbing (spec 008 rules 24c to 24e): the W-4 decisions,
the withholding-claim judge's requests, its calibration items and the scores."""

from __future__ import annotations

import json
import re
import uuid
from pathlib import Path

import pytest
from pydantic import SecretStr

from app.config import Settings
from calc.pay_stub import StubWithholding, stub_withholding
from evals.suites import explain, explain_smoke, explain_w4, live
from evals.suites.base import Budget, SuiteUnavailable
from llm.gateway import (
    JUDGE_WITHHOLDING_CLAIM_PROMPT,
    FakeGateway,
    LLMUnavailable,
    MemoryLedger,
    ScriptedGateway,
)
from llm.prompts import load_prompt
from llm.schemas import (
    ClaimDraft,
    ExplainContext,
    ExplanationDraft,
    WithholdingClaimRequest,
    WithholdingClaimVerdict,
)

ISSUE_181 = "issue-181-stub-01"
SPEC_008 = Path(__file__).resolve().parents[2] / "docs" / "specs" / "008-explain-and-verify.md"
NO_CALIBRATION: list[explain_w4.WithholdingClaimItem] = []


def fake() -> FakeGateway:
    return FakeGateway(Settings(_env_file=None, llm_fake=True), ledger=MemoryLedger())


def case_of(decision: explain.EvalDecision) -> StubWithholding:
    return stub_withholding(
        decision.result["withholding_per_paycheck_cents"], decision.pay_stub_withholding_cents
    )


def test_the_w4_decisions_cover_the_cases() -> None:
    decisions = explain_w4.load_w4_decisions()
    assert len(decisions) == 12
    assert len({decision.id for decision in decisions}) == 12
    assert {decision.calculator for decision in decisions} == {"w4"}
    cases = [case_of(decision) for decision in decisions]
    assert cases.count(StubWithholding.OTHER) == 6
    assert cases.count(StubWithholding.ENTRIES) == 3
    assert cases.count(StubWithholding.NONE) == 3
    other = [d for d in decisions if case_of(d) is StubWithholding.OTHER]
    entries = {d.id: d.result["withholding_per_paycheck_cents"] for d in other}
    stubs = {d.id: d.pay_stub_withholding_cents or 0 for d in other}
    # Less and more than the entries, nothing at all, and within a dollar's rounding.
    assert any(stubs[key] < entries[key] for key in stubs)
    assert any(stubs[key] > entries[key] for key in stubs)
    assert 0 in stubs.values()
    assert any(0 < abs(stubs[key] - entries[key]) < 100 for key in stubs)
    # A suggestion of each kind is somewhere among them.
    suggestions = {decision.result["suggestion"] for decision in decisions}
    assert suggestions >= {"increase_extra_withholding", "decrease_extra_withholding"}
    [issue] = [d for d in decisions if d.id == ISSUE_181]
    assert issue.pay_stub_withholding_cents == 27_244
    assert (
        "current_withholding_per_paycheck_cents"
        not in json.loads(explain.W4_FIXTURES.read_text())[1]["inputs"]
    )
    assert (
        issue.result["withholding_per_paycheck_cents"],
        issue.result["projected_refund_cents"],
    ) == (
        42_316,
        2,
    )
    keys = {citation.key for citation in explain.seed_citations(2026, "w4")}
    for decision in decisions:
        assert set(decision.result["citation_keys"]) <= keys, decision.id


def test_the_stub_withholding_reaches_the_model() -> None:
    [issue] = [d for d in explain_w4.load_w4_decisions() if d.id == ISSUE_181]
    gateway = ScriptedGateway(
        Settings(_env_file=None, llm_fake=True), script=[None], ledger=MemoryLedger()
    )
    [attempt] = explain.explain_decision(gateway, issue)
    assert attempt.verified
    sent = json.loads(str(gateway.contents[0]))["context"]
    assert sent["facts"][1] == {
        "label": "Federal income tax your latest pay stub withholds per paycheck",
        "value": "$272.44",
    }


def test_fake_drafts_verify_for_every_w4_decision() -> None:
    result = explain_w4.score(explain_w4.load_w4_decisions(), fake(), fake(), NO_CALIBRATION)
    assert result.metrics == {
        "first_try_verified": 1.0,
        "no_fallback": 1.0,
        "cited": 1.0,
        "withholding_framing": 1.0,
        "judge_accuracy": 1.0,
    }
    assert result.failures == []


def test_the_fallback_of_every_w4_decision_verifies() -> None:
    decisions = explain_w4.load_w4_decisions()
    drafter = ScriptedGateway(
        Settings(_env_file=None, llm_fake=True),
        script=[explain_smoke.BAD] * (2 * len(decisions)),
        ledger=MemoryLedger(),
    )
    result = explain_w4.score(decisions, drafter, fake(), NO_CALIBRATION)
    assert result.metrics["no_fallback"] == 0.0
    assert result.metrics["cited"] == 1.0
    assert f"{ISSUE_181}: fell back after 2 draft(s)" in result.failures


# Spec 008 rules 24c and 24d: withholding_framing is the judge's verdict on each
# scored decision's final row. These judges are scripted; the live suite asks the model.

CLAIM = "Your employer already withholds what the year's tax needs."


class Claims:
    """A drafter that always claims the entries are in effect, and verifies."""

    def explain(
        self, user_id: uuid.UUID, context: ExplainContext, *, feedback: str | None = None
    ) -> ExplanationDraft:
        return ExplanationDraft(
            concept="How your Form W-4 sets your withholding.",
            text=f"{CLAIM} Your refund will be small.",
            numbers=[],
            what_ifs=[],
            citation_keys=[context.citations[0].key],
        )


class FlagsSentences:
    """A scripted judge: it flags the first of ``flagged`` found in the draft, and
    keeps every request it was sent."""

    def __init__(self, *flagged: str) -> None:
        self.flagged = flagged
        self.requests: list[WithholdingClaimRequest] = []

    def judge_withholding_claim(
        self, user_id: uuid.UUID, request: WithholdingClaimRequest
    ) -> WithholdingClaimVerdict:
        self.requests.append(request)
        parts = [request.draft.concept, request.draft.text, *request.draft.what_ifs]
        for sentence in self.flagged:
            if any(sentence in part for part in parts):
                return WithholdingClaimVerdict(
                    reason="scripted", claims_entries_in_effect=True, sentence=sentence
                )
        return WithholdingClaimVerdict(reason="scripted", claims_entries_in_effect=False)


class AnswersFromLabels:
    """Answers each calibration item with its label, except those in ``wrong``."""

    def __init__(self, items: list[explain_w4.WithholdingClaimItem], *wrong: str) -> None:
        self.labels = {item.request.model_dump_json(): item for item in items}
        self.wrong = set(wrong)

    def judge_withholding_claim(
        self, user_id: uuid.UUID, request: WithholdingClaimRequest
    ) -> WithholdingClaimVerdict:
        item = self.labels[request.model_dump_json()]
        claims = item.claims != (item.id in self.wrong)
        return WithholdingClaimVerdict(
            reason=f"scripted for {item.id}",
            claims_entries_in_effect=claims,
            sentence=item.draft.text if claims else None,
        )


class Fails:
    def judge_withholding_claim(
        self, user_id: uuid.UUID, request: WithholdingClaimRequest
    ) -> WithholdingClaimVerdict:
        raise LLMUnavailable("Anthropic API returned HTTP 529 (InternalServerError)")


def test_withholding_framing_is_the_judges_verdict_on_the_scored_decisions() -> None:
    decisions = explain_w4.load_w4_decisions()
    scored = [d for d in decisions if explain_w4.frames_withholding_scored(d)]
    assert len(scored) == 9
    judge = FlagsSentences(CLAIM)
    result = explain_w4.score(decisions, Claims(), judge, NO_CALIBRATION)
    assert result.metrics["first_try_verified"] == 1.0
    assert result.metrics["withholding_framing"] == 0.0
    assert len(judge.requests) == 9
    [issue] = [r for r, d in zip(judge.requests, scored, strict=True) if d.id == ISSUE_181]
    assert issue == WithholdingClaimRequest(
        entries_withholding="$423.16",
        pay_stub_withholding="$272.44",
        entries_outcome="a refund of $0.02",
        pay_stub_outcome="a balance due of $3,918.70",
        draft=ClaimDraft(
            concept="How your Form W-4 sets your withholding.",
            text=f"{CLAIM} Your refund will be small.",
            what_ifs=[],
        ),
    )
    assert f"{ISSUE_181}: claims the entries are in effect: {CLAIM!r}" in result.failures
    # The decisions whose stub withholds what the entries give may say so, unjudged.
    same = [d for d in decisions if not explain_w4.frames_withholding_scored(d)]
    assert {case_of(d) for d in same} == {StubWithholding.ENTRIES}
    unscored = FlagsSentences(CLAIM)
    metrics = explain_w4.score(same, Claims(), unscored, NO_CALIBRATION).metrics
    assert metrics["withholding_framing"] == 1.0
    assert unscored.requests == []


def test_the_request_names_no_stub_as_null_and_an_even_year_in_words() -> None:
    by_id = {d.id: d for d in explain_w4.load_w4_decisions()}
    draft = ExplanationDraft(concept="c", text="t", numbers=[], what_ifs=[], citation_keys=[])
    no_stub = explain_w4.decision_request(by_id["no-stub-second-job"], draft)
    assert (no_stub.entries_withholding, no_stub.pay_stub_withholding) == ("$146.92", None)
    assert (no_stub.entries_outcome, no_stub.pay_stub_outcome) == (
        "a balance due of $2,360.08",
        None,
    )
    even = explain_w4.decision_request(by_id["credits-cover-the-tax-stub-holds-nothing"], draft)
    assert (even.entries_outcome, even.pay_stub_outcome) == (
        "no refund and nothing due",
        "no refund and nothing due",
    )


def test_a_judge_error_counts_as_a_miss_and_does_not_stop_the_run() -> None:
    items = explain_w4.load_withholding_claims()[:2]
    result = explain_w4.score(explain_w4.load_w4_decisions(), fake(), Fails(), items)
    assert result.metrics["withholding_framing"] == 0.0
    assert result.metrics["judge_accuracy"] == 0.0
    assert result.metrics["first_try_verified"] == 1.0
    assert (
        f"{ISSUE_181}: the withholding-claim judge failed:"
        " LLMUnavailable: Anthropic API returned HTTP 529 (InternalServerError)"
    ) in result.failures
    assert any(line.startswith(f"judge {items[0].id}: ") for line in result.failures)


# Spec 008 rule 24e: the judge's calibration over hand-labeled items.


def test_the_calibration_items_cover_the_cases() -> None:
    items = explain_w4.load_withholding_claims()
    assert len({item.id for item in items}) == len(items)
    claims = [item for item in items if item.claims]
    assert len(claims) >= 8
    assert len(items) - len(claims) >= 12
    assert any(item.pay_stub_cents is None for item in claims)
    assert any(item.pay_stub_cents is None for item in items if not item.claims)
    assert any(item.pay_stub_cents == item.entries_cents for item in claims)
    assert any(claim.draft.what_ifs for claim in claims)
    assert any(claim.draft.concept for claim in claims)
    assert any(item.draft.text.startswith("These entries withhold") for item in items)
    assert any("would" in item.draft.text for item in items if not item.claims)
    # Live sentences carry the figures of the fixture decision they were written for.
    decisions = {d.id: d for d in explain_w4.load_w4_decisions()}
    live = [item for item in items if item.decision is not None]
    assert len(live) == 2
    for item in live:
        request = explain_w4.decision_request(
            decisions[item.decision or ""],
            ExplanationDraft(concept="", text="t", numbers=[], what_ifs=[], citation_keys=[]),
        )
        assert request.model_dump(exclude={"draft"}) == item.request.model_dump(
            exclude={"draft"}
        ), item.id
        assert item.claims, item.id


def test_the_judge_prompt_does_not_quote_the_calibration_items() -> None:
    system = load_prompt(*JUDGE_WITHHOLDING_CLAIM_PROMPT).system
    for item in explain_w4.load_withholding_claims():
        for part in (item.draft.concept, item.draft.text, *item.draft.what_ifs):
            assert not part or part not in system, item.id
    # Nor any of their amounts: its examples use figures of their own.
    for amount in ("$423.16", "$272.44", "$3,918.70", "$155.55", "$297.76"):
        assert amount not in system


def _spec_rows() -> list[tuple[str, str | None, str, str | None, str, bool]]:
    text = SPEC_008.read_text()
    start = text.index("### Withholding framing")
    section = text[start : text.index("\n### ", start + 1)]
    rows = re.findall(
        r"^\| (\$\S+) \| (\S+) \| ([^|]+?) \| ([^|]+?) \| `(.+?)`.* \| (yes|no) \|$",
        section,
        flags=re.MULTILINE,
    )
    return [
        (
            entries,
            None if stub == "none" else stub,
            entries_outcome,
            None if stub_outcome == "none" else stub_outcome,
            sentence,
            label == "yes",
        )
        for entries, stub, entries_outcome, stub_outcome, sentence, label in rows
    ]


def test_every_spec_withholding_framing_row_is_an_item() -> None:
    rows = _spec_rows()
    assert len(rows) == 21
    items = {
        (
            item.request.entries_withholding,
            item.request.pay_stub_withholding,
            item.request.entries_outcome,
            item.request.pay_stub_outcome,
            item.draft.text,
        ): item.claims
        for item in explain_w4.load_withholding_claims()
    }
    for entries, stub, entries_outcome, stub_outcome, sentence, claims in rows:
        key = (entries, stub, entries_outcome, stub_outcome, sentence)
        assert items.get(key) is claims, sentence


def test_judge_accuracy_is_the_share_of_labels_the_judge_matches() -> None:
    items = explain_w4.load_withholding_claims()
    # One decision the judge does not score, so it reads only the calibration items.
    decisions = [
        d for d in explain_w4.load_w4_decisions() if not explain_w4.frames_withholding_scored(d)
    ][:1]
    exact = explain_w4.score(decisions, fake(), AnswersFromLabels(items), items)
    assert exact.metrics["judge_accuracy"] == 1.0
    assert exact.failures == []
    miss = "entries-as-the-subject"
    one_wrong = explain_w4.score(decisions, fake(), AnswersFromLabels(items, miss), items)
    assert one_wrong.metrics["judge_accuracy"] == pytest.approx((len(items) - 1) / len(items))
    [line] = one_wrong.failures
    assert line.startswith(f"judge {miss}: labeled no claim, judged a claim: ")
    free = explain_w4.score(decisions, fake(), fake(), items)
    assert free.metrics["judge_accuracy"] == pytest.approx(
        sum(not item.claims for item in items) / len(items)
    )


def test_one_case_is_a_decision_and_the_judged_metrics_count_only_their_own() -> None:
    items = explain_w4.load_withholding_claims()
    result = explain_w4.score(explain_w4.load_w4_decisions(), fake(), fake(), items)
    assert result.cases == 12
    assert result.case_worth == {
        "withholding_framing": pytest.approx(1 / 9),
        "judge_accuracy": pytest.approx(1 / len(items)),
    }


def test_the_live_suite_needs_a_key(monkeypatch: pytest.MonkeyPatch) -> None:
    no_key = Settings(_env_file=None, anthropic_api_key=None)
    monkeypatch.setattr(live, "_settings", lambda: no_key)
    with pytest.raises(SuiteUnavailable, match="ANTHROPIC_API_KEY"):
        explain_w4.run(Budget(100))


def test_the_live_suite_drafts_and_judges_through_one_gateway(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = Settings(_env_file=None, anthropic_api_key=SecretStr("sk-ant-test"))
    monkeypatch.setattr(live, "_settings", lambda: settings)
    ledgers: list[MemoryLedger] = []

    def gateway(settings: Settings, ledger: MemoryLedger) -> FakeGateway:
        ledgers.append(ledger)
        return FakeGateway(settings, ledger=ledger)

    monkeypatch.setattr(live, "_gateway", gateway)
    result = explain_w4.run(Budget(0))
    items = explain_w4.load_withholding_claims()
    assert result.metrics["first_try_verified"] == 1.0
    assert result.cost_cents == 0
    [ledger] = ledgers
    versions = [entry.prompt_version for entry in ledger.entries]
    assert versions.count("explain/v3") == 12
    assert versions.count("judge_withholding_claim/v1") == 9 + len(items)
