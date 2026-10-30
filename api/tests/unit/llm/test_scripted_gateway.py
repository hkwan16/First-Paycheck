"""ScriptedGateway: FakeGateway answers taken from a script, in order."""

from __future__ import annotations

import datetime as dt
import json
import uuid

import pytest

from app.config import Settings
from db.enums import LlmStatus
from llm.gateway import (
    REFUSAL_REPLY,
    LLMError,
    LLMRefused,
    LLMSchemaError,
    LLMUnavailable,
    MemoryLedger,
    Reply,
    ScriptedGateway,
    ScriptStep,
    Usage,
    reply_with,
)
from llm.schemas import (
    ExplainCitation,
    ExplainContext,
    ExplainFact,
    ExplanationDraft,
    RateClaimDraft,
    RateClaimRequest,
    RateClaimVerdict,
)

NOW = dt.datetime(2026, 10, 21, 15, 0, tzinfo=dt.UTC)
USER = uuid.UUID("00000000-0000-4000-8000-0000000005c1")
CONTEXT = ExplainContext(
    calculator="k401_match",
    tax_year=2026,
    facts=[ExplainFact(label="Match you miss per year", value="$600.00")],
    notes=[],
    citations=[ExplainCitation(key="k401.employer_match", title="T", passage="P")],
    benefits_passages=[],
)
SCRIPTED = ExplanationDraft(
    concept="The match.",
    text="You miss $650.00.",
    numbers=[],
    what_ifs=[],
    citation_keys=["k401.employer_match"],
)


def scripted(*script: ScriptStep) -> tuple[ScriptedGateway, MemoryLedger]:
    ledger = MemoryLedger(clock=lambda: NOW)
    gateway = ScriptedGateway(
        Settings(_env_file=None, llm_fake=True),
        script=script,
        ledger=ledger,
        clock=lambda: NOW,
    )
    return gateway, ledger


def test_answers_in_order() -> None:
    gateway, ledger = scripted(reply_with(SCRIPTED), None)
    assert gateway.explain(USER, CONTEXT) == SCRIPTED
    # None is FakeGateway's own answer: the facts as given, citing the first key.
    default = gateway.explain(USER, CONTEXT, feedback="Unmatched: $650.00")
    assert default.text == "Match you miss per year: $600.00."
    assert [entry.status for entry in ledger.entries] == [LlmStatus.OK, LlmStatus.OK]
    assert len(gateway.contents) == 2
    assert "Unmatched: $650.00" in str(gateway.contents[1])


def test_refusals_errors_and_bad_json_go_through_the_gateway() -> None:
    not_json = Reply(stop_reason="end_turn", text="nope", usage=Usage())
    gateway, ledger = scripted(REFUSAL_REPLY, LLMUnavailable("down"), not_json)
    with pytest.raises(LLMRefused):
        gateway.explain(USER, CONTEXT)
    with pytest.raises(LLMUnavailable):
        gateway.explain(USER, CONTEXT)
    with pytest.raises(LLMSchemaError):
        gateway.explain(USER, CONTEXT)
    assert [entry.status for entry in ledger.entries] == [
        LlmStatus.REFUSAL,
        LlmStatus.API_ERROR,
        LlmStatus.SCHEMA_ERROR,
    ]


def test_an_exhausted_script_is_an_error() -> None:
    gateway, _ = scripted()
    with pytest.raises(LLMError, match="script"):
        gateway.explain(USER, CONTEXT)


REQUEST = RateClaimRequest(
    chosen_rate="5%",
    pay_stub_rate="3%",
    full_match_rate="5%",
    draft=RateClaimDraft(concept="c", text="You are already contributing 5%.", what_ifs=[]),
)
CLAIM = RateClaimVerdict(
    reason="It calls the chosen 5% current while the stub shows 3%.",
    claims_chosen_rate_in_effect=True,
    sentence="You are already contributing 5%.",
)


def test_the_judge_is_scripted_and_the_fake_reads_no_claim() -> None:
    """Spec 008 rule 24a: FakeGateway's verdict is "no claim", so free runs need no key."""
    gateway, ledger = scripted(reply_with(CLAIM), None)
    assert gateway.judge_rate_claim(USER, REQUEST) == CLAIM
    default = gateway.judge_rate_claim(USER, REQUEST)
    assert (default.claims_chosen_rate_in_effect, default.sentence) == (False, None)
    assert [(entry.purpose.value, entry.prompt_version) for entry in ledger.entries] == [
        ("explain", "judge_rate_claim/v1"),
        ("explain", "judge_rate_claim/v1"),
    ]
    assert json.loads(str(gateway.contents[0])) == REQUEST.model_dump(mode="json")
