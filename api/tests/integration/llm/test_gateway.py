"""The LLM gateway against a mocked Messages API (spec 003 rules 19-27).

The Anthropic SDK is built on httpx2, which respx cannot intercept, so the
HTTP layer is mocked with ``httpx2.MockTransport`` handed to the SDK as its
HTTP client. Everything above the transport (request building, retries off,
response parsing, the ledger and the budget check) is the real code.
"""

from __future__ import annotations

import base64
import datetime as dt
import json
from collections.abc import Callable
from typing import Any

import httpx2
import pytest
from pydantic import SecretStr
from sqlalchemy import Connection, text

from app.config import Settings
from db.enums import JobKind, LlmStatus
from llm.gateway import (
    FAKE_FIXTURES,
    CategorizeItem,
    FakeGateway,
    ImagePage,
    LLMBudgetExceeded,
    LLMError,
    LLMGateway,
    LLMMisconfigured,
    LLMNotConfigured,
    LLMRefused,
    LLMSchemaError,
    LLMUnavailable,
    MemoryLedger,
    ModelPage,
    TextPage,
    get_gateway,
)
from llm.schemas import (
    BenefitsSummaryExtraction,
    CategoryBatch,
    ExplainCitation,
    ExplainContext,
    ExplainFact,
    ExplanationDraft,
    PayStubExtraction,
    RateClaimDraft,
    RateClaimRequest,
    RateClaimVerdict,
)
from tests.conftest import FixtureUser
from tests.support.factories import make_job
from verify.allowed import AllowedNumbers
from verify.verify import verify_explanation

NOW = dt.datetime(2026, 10, 21, 15, 0, tzinfo=dt.UTC)
ITEMS = [
    CategorizeItem(
        id=1, merchant="blue bottle coffee", amount_cents=650, date=dt.date(2026, 10, 3)
    ),
    CategorizeItem(id=2, merchant="netflix.com", amount_cents=1599, date=dt.date(2026, 10, 5)),
]
GOOD = {"items": [{"id": 1, "category": "dining", "confidence": 0.93}]}
USAGE = {
    "input_tokens": 200,
    "output_tokens": 120,
    "cache_read_input_tokens": 2_000,
    "cache_creation_input_tokens": 100,
}

Handler = Callable[[httpx2.Request], httpx2.Response]


def message(
    body: str, *, stop_reason: str = "end_turn", usage: dict[str, int] | None = None
) -> dict[str, Any]:
    return {
        "id": "msg_test",
        "type": "message",
        "role": "assistant",
        "model": "claude-sonnet-5-5",
        "content": [{"type": "text", "text": body}],
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "usage": usage or USAGE,
    }


class Api:
    """A scripted Messages API that records what it was sent."""

    def __init__(self, *responses: httpx2.Response | Exception) -> None:
        self.responses = list(responses)
        self.requests: list[dict[str, Any]] = []
        self.headers: list[httpx2.Headers] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(json.loads(request.content))
        self.headers.append(request.headers)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def ok(body: dict[str, Any] | str = GOOD, **kwargs: Any) -> httpx2.Response:
    text_body = body if isinstance(body, str) else json.dumps(body)
    return httpx2.Response(200, json=message(text_body, **kwargs))


def settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "anthropic_api_key": SecretStr("sk-ant-test"),
        "llm_fake": False,
        "llm_daily_budget_cents": 50,
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)


def gateway(connection: Connection, api: Api, **overrides: Any) -> LLMGateway:
    return LLMGateway(
        settings(**overrides),
        bind=connection,
        http_client=httpx2.Client(transport=httpx2.MockTransport(api)),
        max_retries=0,
        clock=lambda: NOW,
    )


def ledger(connection: Connection, user: FixtureUser) -> list[dict[str, Any]]:
    rows = connection.execute(
        text(
            "SELECT purpose, model, prompt_version, input_tokens, output_tokens,"
            " cache_read_tokens, cost_microcents, latency_ms, status, job_id"
            " FROM llm_calls WHERE user_id = :user ORDER BY created_at, id"
        ),
        {"user": user.id},
    )
    return [dict(row._mapping) for row in rows]


def spend(connection: Connection, user: FixtureUser, microcents: int, at: dt.datetime) -> None:
    connection.execute(
        text(
            "INSERT INTO llm_calls (user_id, purpose, model, prompt_version, cost_microcents,"
            " latency_ms, status, created_at)"
            " VALUES (:user, 'categorize', 'claude-haiku-5-5', 'categorize/v1',"
            " :cost, 1, 'ok', :at)"
        ),
        {"user": user.id, "cost": microcents, "at": at},
    )


def test_categorize_sends_minimal_data_and_records_the_call(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    api = Api(ok())
    job_id = make_job(db_connection, user_a.id)
    batch = gateway(db_connection, api).categorize(user_a.id, ITEMS, job_id=job_id)

    assert batch == CategoryBatch.model_validate(GOOD)
    sent = api.requests[0]
    assert sent["model"] == "claude-sonnet-5-5"
    assert sent["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert sent["output_config"]["effort"] == "low"
    assert sent["output_config"]["format"]["type"] == "json_schema"
    assert "items" in sent["output_config"]["format"]["schema"]["properties"]
    assert "temperature" not in sent
    assert "thinking" not in sent
    assert [m["role"] for m in sent["messages"]] == ["user"]
    payload = json.loads(sent["messages"][0]["content"])
    assert payload == {
        "items": [
            {
                "id": 1,
                "merchant": "blue bottle coffee",
                "direction": "out",
                "amount": "6.50",
                "date": "2026-10-03",
            },
            {
                "id": 2,
                "merchant": "netflix.com",
                "direction": "out",
                "amount": "15.99",
                "date": "2026-10-05",
            },
        ]
    }
    assert api.headers[0]["x-api-key"] == "sk-ant-test"

    [row] = ledger(db_connection, user_a)
    # Sonnet (spec 003 rule 26; categorize moved off Haiku in #136): (200 + 100)
    # uncached-plus-writes input; cost uses each rate:
    # (200 * 2.00 + 120 * 10.00 + 2000 * 0.20 + 100 * 2.50) * 100 = 225000.
    assert row == {
        "purpose": "categorize",
        "model": "claude-sonnet-5-5",
        "prompt_version": "categorize/v3",
        "input_tokens": 300,
        "output_tokens": 120,
        "cache_read_tokens": 2_000,
        "cost_microcents": 225_000,
        "latency_ms": row["latency_ms"],
        "status": "ok",
        "job_id": job_id,
    }
    assert row["latency_ms"] >= 0


def test_negative_amounts_keep_their_sign(db_connection: Connection, user_a: FixtureUser) -> None:
    api = Api(ok({"items": []}))
    refund = CategorizeItem(id=1, merchant="acme payroll", amount_cents=-250_005, date=NOW.date())
    gateway(db_connection, api).categorize(user_a.id, [refund])
    payload = json.loads(api.requests[0]["messages"][0]["content"])
    assert payload["items"][0]["amount"] == "-2500.05"
    # Spec 003 rule 9: the direction is spelled out, not left to the sign alone.
    assert payload["items"][0]["direction"] == "in"


def test_refusal_raises_before_output_is_read(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    api = Api(ok("I can't help with that.", stop_reason="refusal"))
    with pytest.raises(LLMRefused):
        gateway(db_connection, api).categorize(user_a.id, ITEMS)
    [row] = ledger(db_connection, user_a)
    assert (row["status"], row["output_tokens"], row["cost_microcents"]) == (
        "refusal",
        120,
        225_000,  # the same usage at Sonnet's rates, as in the first test
    )


@pytest.mark.parametrize(
    "body",
    [
        "not json at all",
        json.dumps({"items": [{"id": 1, "category": "snacks", "confidence": 0.5}]}),
        json.dumps({"labels": []}),
    ],
)
def test_schema_violations_raise(db_connection: Connection, user_a: FixtureUser, body: str) -> None:
    with pytest.raises(LLMSchemaError):
        gateway(db_connection, Api(ok(body))).categorize(user_a.id, ITEMS)
    assert [row["status"] for row in ledger(db_connection, user_a)] == ["schema_error"]


def test_a_reply_without_text_is_a_schema_error(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    reply = message("") | {"content": []}
    with pytest.raises(LLMSchemaError):
        gateway(db_connection, Api(httpx2.Response(200, json=reply))).categorize(user_a.id, ITEMS)


def test_budget_exceeded_blocks_before_any_http_call(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    spend(db_connection, user_a, 30_000_000, NOW - dt.timedelta(hours=2))
    spend(db_connection, user_a, 20_000_000, NOW - dt.timedelta(hours=1))
    api = Api()
    with pytest.raises(LLMBudgetExceeded):
        gateway(db_connection, api).categorize(user_a.id, ITEMS)
    assert api.requests == []
    blocked = ledger(db_connection, user_a)[-1]
    assert (blocked["status"], blocked["input_tokens"], blocked["cost_microcents"]) == (
        "budget_blocked",
        0,
        0,
    )


def test_budget_is_per_utc_day_and_per_user(
    db_connection: Connection, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    midnight = dt.datetime(2026, 10, 21, tzinfo=dt.UTC)
    spend(db_connection, user_a, 49_999_999, midnight)
    spend(db_connection, user_a, 100_000_000, midnight - dt.timedelta(microseconds=1))
    spend(db_connection, user_b, 100_000_000, NOW)
    api = Api(ok())
    gateway(db_connection, api).categorize(user_a.id, ITEMS)
    assert len(api.requests) == 1


def test_a_zero_budget_blocks_everything(db_connection: Connection, user_a: FixtureUser) -> None:
    with pytest.raises(LLMBudgetExceeded):
        gateway(db_connection, Api(), llm_daily_budget_cents=0).categorize(user_a.id, ITEMS)


@pytest.mark.parametrize("status", [429, 500, 529])
def test_rate_limits_and_server_errors_are_unavailable(
    db_connection: Connection, user_a: FixtureUser, status: int
) -> None:
    error = {"type": "error", "error": {"type": "overloaded_error", "message": "busy"}}
    with pytest.raises(LLMUnavailable):
        gateway(db_connection, Api(httpx2.Response(status, json=error))).categorize(
            user_a.id, ITEMS
        )
    [row] = ledger(db_connection, user_a)
    assert (row["status"], row["cost_microcents"]) == ("api_error", 0)


def test_connection_failures_are_unavailable(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    api = Api(httpx2.ConnectError("refused"))
    with pytest.raises(LLMUnavailable):
        gateway(db_connection, api).categorize(user_a.id, ITEMS)
    assert [row["status"] for row in ledger(db_connection, user_a)] == ["api_error"]


@pytest.mark.parametrize(
    ("status", "kind"),
    [(401, "authentication_error"), (403, "permission_error"), (404, "not_found_error")],
)
def test_a_rejected_key_or_model_is_misconfigured(
    db_connection: Connection,
    user_a: FixtureUser,
    caplog: pytest.LogCaptureFixture,
    status: int,
    kind: str,
) -> None:
    """Configuration no retry can fix (spec 003 rule 24); still on the ledger."""
    error = {"type": "error", "error": {"type": kind, "message": "invalid x-api-key"}}
    with caplog.at_level("ERROR", logger="llm.gateway"), pytest.raises(LLMMisconfigured) as failure:
        gateway(db_connection, Api(httpx2.Response(status, json=error))).categorize(
            user_a.id, ITEMS
        )
    assert isinstance(failure.value, LLMError)
    assert not isinstance(failure.value, LLMUnavailable)
    assert f"HTTP {status}" in str(failure.value)
    [row] = ledger(db_connection, user_a)
    assert (row["status"], row["cost_microcents"]) == ("api_error", 0)
    [record] = [r for r in caplog.records if r.levelname == "ERROR"]
    assert f"HTTP {status}" in record.getMessage()
    assert "sk-ant-test" not in record.getMessage()


def test_other_client_errors_are_plain_llm_errors(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    error = {"type": "error", "error": {"type": "invalid_request_error", "message": "bad"}}
    with pytest.raises(LLMError) as failure:
        gateway(db_connection, Api(httpx2.Response(400, json=error))).categorize(user_a.id, ITEMS)
    assert not isinstance(failure.value, LLMUnavailable | LLMMisconfigured)
    assert "sk-ant-test" not in str(failure.value)


def test_an_empty_batch_never_calls(db_connection: Connection, user_a: FixtureUser) -> None:
    api = Api()
    assert gateway(db_connection, api).categorize(user_a.id, []) == CategoryBatch(items=[])
    assert api.requests == []
    assert ledger(db_connection, user_a) == []


def test_the_ledger_never_stores_text(db_connection: Connection) -> None:
    columns = set(
        db_connection.execute(
            text(
                "SELECT column_name FROM information_schema.columns WHERE table_name = 'llm_calls'"
            )
        ).scalars()
    )
    assert not columns & {"prompt", "output", "response", "content", "text", "merchant"}


# FakeGateway -----------------------------------------------------------------


def fake(connection: Connection, **overrides: Any) -> FakeGateway:
    return FakeGateway(settings(llm_fake=True, **overrides), bind=connection, clock=lambda: NOW)


def test_fake_answers_from_fixtures(db_connection: Connection, user_a: FixtureUser) -> None:
    batch = fake(db_connection).categorize(user_a.id, ITEMS)
    by_id = {item.id: (item.category, item.confidence) for item in batch.items}
    assert by_id[2] == ("subscriptions", 0.97)
    assert by_id[1][0] == "dining"
    [row] = ledger(db_connection, user_a)
    assert (row["model"], row["cost_microcents"], row["status"]) == ("fake", 0, "ok")


def test_fake_labels_unknown_merchants_other(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    unknown = CategorizeItem(id=1, merchant="zz unheard of", amount_cents=100, date=NOW.date())
    [item] = fake(db_connection).categorize(user_a.id, [unknown]).items
    assert (item.category, item.confidence) == ("other", 0.5)


def test_fake_answers_money_in_by_merchant_a_refund_included(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    """Spec 003 rule 27: a money-in item at a spending merchant is a refund."""
    items = [
        CategorizeItem(id=1, merchant="acme corp payroll", amount_cents=-300_000, date=NOW.date()),
        CategorizeItem(
            id=2, merchant="united airlines refund", amount_cents=-45_000, date=NOW.date()
        ),
    ]
    batch = fake(db_connection).categorize(user_a.id, items)
    assert [(item.id, item.category) for item in batch.items] == [(1, "income"), (2, "travel")]


def test_fake_shares_the_budget_check(db_connection: Connection, user_a: FixtureUser) -> None:
    with pytest.raises(LLMBudgetExceeded):
        fake(db_connection, llm_daily_budget_cents=0).categorize(user_a.id, ITEMS)
    assert [row["status"] for row in ledger(db_connection, user_a)] == ["budget_blocked"]


def test_get_gateway_selects_by_settings(db_connection: Connection) -> None:
    assert isinstance(get_gateway(settings(llm_fake=True), bind=db_connection), FakeGateway)
    real = get_gateway(settings(), bind=db_connection)
    assert type(real) is LLMGateway
    with pytest.raises(LLMNotConfigured, match="ANTHROPIC_API_KEY"):
        get_gateway(settings(anthropic_api_key=None), bind=db_connection)


# Extraction (spec 005 rules 6-8) ---------------------------------------------

PNG_1 = b"\x89PNG\r\n\x1a\n page one"
PNG_3 = b"\x89PNG\r\n\x1a\n page three"
PAGES: list[ModelPage] = [
    ImagePage(number=1, png=PNG_1),
    TextPage(number=2, text="Gross Pay 2,708.33\nSSN [REDACTED]"),
    ImagePage(number=3, png=PNG_3),
]
STUB_ANSWER = json.loads((FAKE_FIXTURES / "extract_pay_stub.json").read_text())
SONNET_USAGE = {
    "input_tokens": 3_000,
    "output_tokens": 900,
    "cache_read_input_tokens": 0,
    "cache_creation_input_tokens": 0,
}


def test_extract_sends_images_before_one_text_block(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    api = Api(ok(STUB_ANSWER, usage=SONNET_USAGE))
    job_id = make_job(db_connection, user_a.id, kind=JobKind.INGEST_EXTRACT)
    stub = gateway(db_connection, api).extract_pay_stub(user_a.id, PAGES, job_id=job_id)

    assert stub == PayStubExtraction.model_validate(STUB_ANSWER)
    sent = api.requests[0]
    assert sent["model"] == "claude-sonnet-5-5"
    assert sent["output_config"]["effort"] == "low"
    assert "gross_cents" in sent["output_config"]["format"]["schema"]["properties"]
    assert sent["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert "temperature" not in sent
    [message_sent] = sent["messages"]
    assert message_sent["role"] == "user"
    blocks = message_sent["content"]
    assert [block["type"] for block in blocks] == ["image", "image", "text"]
    assert blocks[0]["source"] == {
        "type": "base64",
        "media_type": "image/png",
        "data": base64.b64encode(PNG_1).decode(),
    }
    assert base64.b64decode(blocks[1]["source"]["data"]) == PNG_3
    body = blocks[2]["text"]
    assert "pages 1, 3" in body
    assert "Page 2 (text layer):\nGross Pay 2,708.33\nSSN [REDACTED]" in body

    [row] = ledger(db_connection, user_a)
    # Sonnet: (3000 * 2.00 + 900 * 10.00) * 100 = 1,500,000 microcents.
    assert (row["purpose"], row["prompt_version"], row["cost_microcents"], row["job_id"]) == (
        "extract",
        "extract_pay_stub/v1",
        1_500_000,
        job_id,
    )


def test_text_only_extraction_has_no_image_preamble(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    api = Api(ok(STUB_ANSWER))
    gateway(db_connection, api).extract_pay_stub(user_a.id, [PAGES[1]])
    [block] = api.requests[0]["messages"][0]["content"]
    assert block["type"] == "text"
    assert "Images above" not in block["text"]


def test_extract_benefits_uses_its_own_prompt(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    answer = json.loads((FAKE_FIXTURES / "extract_benefits.json").read_text())
    api = Api(ok(answer))
    benefits = gateway(db_connection, api).extract_benefits(user_a.id, [PAGES[1]])
    assert benefits == BenefitsSummaryExtraction.model_validate(answer)
    properties = api.requests[0]["output_config"]["format"]["schema"]["properties"]
    assert {"plans", "match_tiers", "vesting_years"} <= set(properties)
    assert ledger(db_connection, user_a)[0]["prompt_version"] == "extract_benefits/v2"


def test_extract_with_no_pages_sends_and_records_nothing(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    api = Api()
    with pytest.raises(ValueError, match="no pages"):
        gateway(db_connection, api).extract_pay_stub(user_a.id, [])
    assert api.requests == []
    assert ledger(db_connection, user_a) == []


def test_extract_refusal_raises(db_connection: Connection, user_a: FixtureUser) -> None:
    api = Api(ok("I can't read this document.", stop_reason="refusal"))
    with pytest.raises(LLMRefused):
        gateway(db_connection, api).extract_pay_stub(user_a.id, PAGES)
    assert [row["status"] for row in ledger(db_connection, user_a)] == ["refusal"]


def test_fake_extracts_from_fixtures(db_connection: Connection, user_a: FixtureUser) -> None:
    stub = fake(db_connection).extract_pay_stub(user_a.id, PAGES)
    assert stub.net_cents.value == 199_604
    benefits = fake(db_connection).extract_benefits(user_a.id, PAGES)
    assert [plan.kind.value for plan in benefits.plans] == ["hdhp", "ppo"]
    assert [tier.band_pct.value for tier in benefits.match_tiers] == [3, 2]
    assert benefits.vesting_years.value == 3
    # Both rows carry the same frozen timestamp, so compare without order.
    assert sorted(row["prompt_version"] for row in ledger(db_connection, user_a)) == [
        "extract_benefits/v2",
        "extract_pay_stub/v1",
    ]


def test_a_memory_ledger_needs_no_database(user_a: FixtureUser) -> None:
    memory = MemoryLedger(clock=lambda: NOW)
    gateway_without_db = FakeGateway(settings(llm_fake=True), ledger=memory, clock=lambda: NOW)
    gateway_without_db.extract_pay_stub(user_a.id, PAGES)
    [entry] = memory.entries
    assert (entry.status, entry.prompt_version, entry.cost_microcents) == (
        LlmStatus.OK,
        "extract_pay_stub/v1",
        0,
    )
    assert memory.spent_today(user_a.id) == 0


# Explain (spec 008 rule 10) ---------------------------------------------------

EXPLAIN_CONTEXT = ExplainContext(
    calculator="k401_match",
    tax_year=2026,
    facts=[
        ExplainFact(label="Your contribution rate", value="3%"),
        ExplainFact(label="Match you miss per year", value="$600.00"),
    ],
    notes=[],
    citations=[
        ExplainCitation(key="k401.employer_match", title="Matching", passage="An employer..."),
    ],
    benefits_passages=["Matching contributions vest after one year."],
)
EXPLAIN_ANSWER = {
    "concept": "Your employer matches what you put in.",
    "text": "At 3% you miss $600.00 a year.",
    "numbers": [{"value": "$600.00", "label": "Match you miss per year"}],
    "what_ifs": [],
    "citation_keys": ["k401.employer_match"],
}


def test_explain_sends_the_context_and_the_feedback(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    api = Api(ok(EXPLAIN_ANSWER), ok(EXPLAIN_ANSWER))
    model = gateway(db_connection, api)

    draft = model.explain(user_a.id, EXPLAIN_CONTEXT)
    assert draft == ExplanationDraft.model_validate(EXPLAIN_ANSWER)
    first = api.requests[0]
    assert first["model"] == "claude-sonnet-5-5"
    assert first["output_config"]["effort"] == "medium"
    assert "citation_keys" in first["output_config"]["format"]["schema"]["properties"]
    [sent] = first["messages"]
    assert json.loads(sent["content"]) == {"context": EXPLAIN_CONTEXT.model_dump(mode="json")}

    model.explain(user_a.id, EXPLAIN_CONTEXT, feedback="Unmatched number: $650.00")
    retry = json.loads(api.requests[1]["messages"][0]["content"])
    assert retry["feedback"] == "Unmatched number: $650.00"

    rows = ledger(db_connection, user_a)
    assert [(row["purpose"], row["prompt_version"]) for row in rows] == [
        ("explain", "explain/v3"),
        ("explain", "explain/v3"),
    ]


def test_explain_refusal_raises(db_connection: Connection, user_a: FixtureUser) -> None:
    api = Api(ok("I can't help with that.", stop_reason="refusal"))
    with pytest.raises(LLMRefused):
        gateway(db_connection, api).explain(user_a.id, EXPLAIN_CONTEXT)


def test_fake_explains_with_facts_that_verify(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    draft = fake(db_connection).explain(user_a.id, EXPLAIN_CONTEXT)
    assert draft.citation_keys == ["k401.employer_match"]
    assert [claim.value for claim in draft.numbers] == ["3%", "$600.00"]
    allowed = AllowedNumbers.from_decision({"missed_cents": 60_000, "contribution_pct": "3.00"})
    assert verify_explanation(draft, allowed, {"k401.employer_match"}).passed
    assert ledger(db_connection, user_a)[0]["prompt_version"] == "explain/v3"


# The explain eval's rate-claim judge (spec 008 rule 24a) ---------------------------

JUDGE_REQUEST = RateClaimRequest(
    chosen_rate="5%",
    pay_stub_rate="3%",
    full_match_rate="5%",
    draft=RateClaimDraft(
        concept="Your employer matches what you put in.",
        text="You are already contributing 5%.",
        what_ifs=[],
    ),
)
JUDGE_ANSWER = {
    "reason": "It calls the chosen 5% current while the stub shows 3%.",
    "claims_chosen_rate_in_effect": True,
    "sentence": "You are already contributing 5%.",
}


def test_judge_rate_claim_sends_the_request_on_the_explain_model(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    api = Api(ok(JUDGE_ANSWER))
    verdict = gateway(db_connection, api).judge_rate_claim(user_a.id, JUDGE_REQUEST)
    assert verdict == RateClaimVerdict.model_validate(JUDGE_ANSWER)
    [request] = api.requests
    assert request["model"] == "claude-sonnet-5-5"
    # The reason comes first, so the model works out which rate is meant before it answers.
    schema = request["output_config"]["format"]["schema"]
    assert list(schema["properties"]) == ["reason", "claims_chosen_rate_in_effect", "sentence"]
    [sent] = request["messages"]
    assert json.loads(sent["content"]) == JUDGE_REQUEST.model_dump(mode="json")
    [row] = ledger(db_connection, user_a)
    assert (row["purpose"], row["prompt_version"], row["status"]) == (
        "explain",
        "judge_rate_claim/v1",
        "ok",
    )
    assert row["cost_microcents"] > 0


def test_a_verdict_that_claims_without_a_sentence_is_a_schema_error(
    db_connection: Connection, user_a: FixtureUser
) -> None:
    api = Api(ok({**JUDGE_ANSWER, "sentence": None}))
    with pytest.raises(LLMSchemaError):
        gateway(db_connection, api).judge_rate_claim(user_a.id, JUDGE_REQUEST)
    assert ledger(db_connection, user_a)[0]["status"] == "schema_error"


def test_the_judge_shares_the_budget_check(db_connection: Connection, user_a: FixtureUser) -> None:
    api = Api()
    with pytest.raises(LLMBudgetExceeded):
        gateway(db_connection, api, llm_daily_budget_cents=0).judge_rate_claim(
            user_a.id, JUDGE_REQUEST
        )
    assert api.requests == []
