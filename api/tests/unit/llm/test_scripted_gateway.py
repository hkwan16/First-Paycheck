"""ScriptedGateway: FakeGateway answers taken from a script, in order."""

from __future__ import annotations

import datetime as dt
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
from llm.schemas import ExplainCitation, ExplainContext, ExplainFact, ExplanationDraft

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
