"""POST /explain and GET /decisions/{id}/explanation (spec 008 rules 15-23)."""

from __future__ import annotations

import datetime as dt
import json
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import Connection, text

from app.config import Settings, get_settings
from app.db import user_session_for
from app.deps import get_llm_gateway, get_now
from llm.gateway import REFUSAL_REPLY, Gateway, ScriptedGateway, ScriptStep, reply_with
from llm.schemas import ExplanationDraft
from retrieval.context import NO_STUB_NOTE, STUB_DIFFERS_NOTE, STUB_SAME_NOTE
from tests.conftest import FixtureUser
from tests.rls.test_cross_user import EMERGENCY_FUND_INPUTS
from tests.support.factories import STUB_01, make_document, make_pay_stub
from tests.unit.calc.test_health_plans_examples import B_TWIN, A, B
from tests.unit.calc.test_health_plans_examples import payload as health_payload

Client = Callable[[FixtureUser], TestClient]

EXAMPLE_1: dict[str, Any] = {
    "salary_cents": 6_000_000,
    "pay_periods_per_year": 26,
    "match_tiers": [
        {"employee_pct_upto": "3", "employer_pct": "100"},
        {"employee_pct_upto": "5", "employer_pct": "50"},
    ],
    "contribution_pct": "3",
    "tax_year": 2026,
    "filing_status": "single",
    "age": 30,
}
# A number no decision of example 1 allows.
BAD = reply_with(
    ExplanationDraft(
        concept="The match.",
        text="You would get $123,456.78 more.",
        numbers=[],
        what_ifs=[],
        citation_keys=["k401.employer_match"],
    )
)
# None: FakeGateway's own draft, which states the facts and verifies.
GOOD = None


class Script:
    """Installs a ScriptedGateway for the app and keeps every one it built."""

    def __init__(self, app: FastAPI, connection: Connection) -> None:
        self._app = app
        self._connection = connection
        self.gateways: list[ScriptedGateway] = []

    def __call__(self, *steps: ScriptStep) -> None:
        gateway = ScriptedGateway(
            Settings(_env_file=None, llm_fake=True), script=steps, bind=self._connection
        )
        self.gateways.append(gateway)

        def factory() -> Gateway:
            return gateway

        self._app.dependency_overrides[get_llm_gateway] = lambda: factory

    @property
    def sent(self) -> list[dict[str, Any]]:
        return [
            json.loads(str(content)) for gateway in self.gateways for content in gateway.contents
        ]


@pytest.fixture
def script(app: FastAPI, db_connection: Connection, seeded_citations: Connection) -> Script:
    return Script(app, db_connection)


def save_decision(client: TestClient) -> str:
    result = client.post("/calc/401k-match", json=EXAMPLE_1)
    saved = client.post(
        "/decisions",
        json={"calculator": "k401_match", "inputs": EXAMPLE_1, "result": result.json()},
    )
    assert saved.status_code == 201, saved.text
    decision_id: str = saved.json()["decision_id"]
    return decision_id


@pytest.fixture
def decision(client_as: Client, user_a: FixtureUser) -> str:
    return save_decision(client_as(user_a))


def explain(client: TestClient, decision_id: str, **body: Any) -> dict[str, Any]:
    response = client.post("/explain", json={"decision_id": decision_id, **body})
    assert response.status_code == 200, response.text
    out: dict[str, Any] = response.json()
    return out


def rows(connection: Connection, decision_id: str) -> list[tuple[int, int, bool, bool, str]]:
    return [
        (row.attempt, row.retries, row.verified, row.fallback, row.prompt_version)
        for row in connection.execute(
            text(
                "SELECT attempt, retries, verified, fallback, prompt_version FROM explanations"
                " WHERE decision_id = :d ORDER BY created_at, attempt"
            ),
            {"d": decision_id},
        )
    ]


def test_pass_first_try(
    script: Script, client_as: Client, user_a: FixtureUser, decision: str, db_connection: Connection
) -> None:
    script(GOOD)
    out = explain(client_as(user_a), decision)
    assert (out["attempt"], out["retries"], out["verified"], out["fallback"]) == (1, 0, True, False)
    assert out["decision_id"] == decision
    assert out["prompt_version"] == "explain/v2"
    assert out["verification"]["numbers_unmatched"] == []
    assert out["verification"]["has_citation"] is True
    [citation] = out["citations"]
    assert citation["key"] == script.sent[0]["context"]["citations"][0]["key"]
    assert citation["url"].startswith("https://www.irs.gov/")
    assert citation["passage"]
    assert rows(db_connection, decision) == [(1, 0, True, False, "explain/v2")]
    # The model saw the decision's facts and no feedback.
    context = script.sent[0]["context"]
    missed = {"label": "Match you miss per year at the rate you chose", "value": "$600.00"}
    assert missed in context["facts"]
    assert "feedback" not in script.sent[0]
    # No pay stub is confirmed, so nothing says what goes in now (rule 7a).
    assert context["notes"] == [NO_STUB_NOTE]


def test_fail_then_pass(
    script: Script, client_as: Client, user_a: FixtureUser, decision: str, db_connection: Connection
) -> None:
    script(BAD, GOOD)
    out = explain(client_as(user_a), decision)
    assert (out["attempt"], out["retries"], out["verified"], out["fallback"]) == (2, 1, True, False)
    assert rows(db_connection, decision) == [
        (1, 0, False, False, "explain/v2"),
        (2, 1, True, False, "explain/v2"),
    ]
    assert "$123,456.78" in script.sent[1]["feedback"]


def test_fail_twice_falls_back(
    script: Script, client_as: Client, user_a: FixtureUser, decision: str, db_connection: Connection
) -> None:
    script(BAD, BAD)
    out = explain(client_as(user_a), decision)
    assert (out["attempt"], out["retries"], out["verified"], out["fallback"]) == (3, 1, False, True)
    assert out["prompt_version"] == "fallback/v2"
    # The plain calculator result, cited.
    assert "$1,800.00" in out["text"]
    assert "$600.00" in out["text"]
    assert out["verification"]["numbers_unmatched"] == []
    assert [c["key"] for c in out["citations"]] == [
        "k401.employer_match",
        "k401.pretax_deferral",
        "k401.deferral_limit",
        "k401.federal_brackets",
    ]
    assert rows(db_connection, decision) == [
        (1, 0, False, False, "explain/v2"),
        (2, 1, False, False, "explain/v2"),
        (3, 1, False, True, "fallback/v2"),
    ]


# Issue 132 (spec 008 rule 7a): stub-01 shows 3%; the person chose 5%.
ISSUE_132: dict[str, Any] = {**EXAMPLE_1, "salary_cents": 9_500_010, "contribution_pct": "5"}


def confirm_stub(connection: Connection, user: FixtureUser, **fields: Any) -> None:
    document = make_document(connection, user.id, with_blob=False)
    make_pay_stub(connection, user.id, document, **{**STUB_01, **fields})


def save(client: TestClient, inputs: dict[str, Any]) -> str:
    result = client.post("/calc/401k-match", json=inputs)
    saved = client.post(
        "/decisions", json={"calculator": "k401_match", "inputs": inputs, "result": result.json()}
    )
    assert saved.status_code == 201, saved.text
    decision_id: str = saved.json()["decision_id"]
    return decision_id


def test_context_has_the_pay_stub_rate(
    script: Script, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    confirm_stub(db_connection, user_a)
    decision_id = save(client_as(user_a), ISSUE_132)
    script(GOOD)
    out = explain(client_as(user_a), decision_id)
    assert (out["attempt"], out["verified"], out["fallback"]) == (1, True, False)
    context = script.sent[0]["context"]
    assert context["facts"][:2] == [
        {"label": "Contribution rate you chose", "value": "5%"},
        {"label": "401(k) contribution rate your latest pay stub shows", "value": "3%"},
    ]
    assert context["notes"] == [STUB_DIFFERS_NOTE]
    # The fake's draft states the stub's 3%, which the verifier allows.
    assert "your latest pay stub shows: 3%." in out["text"]


def test_the_newest_stub_gives_the_rate(
    script: Script, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    # An older stub at 3%, then one at 5% once the election took effect:
    # 18,269 of 365,385 is 5.00 (365,385 x 5% = 18,269.25).
    confirm_stub(db_connection, user_a)
    confirm_stub(
        db_connection,
        user_a,
        pay_date=dt.date(2026, 4, 24),
        period_start=dt.date(2026, 4, 6),
        period_end=dt.date(2026, 4, 19),
        retirement_contribution_cents=18_269,
        net_cents=275_086 - (18_269 - 10_962),
    )
    decision_id = save(client_as(user_a), ISSUE_132)
    script(GOOD)
    explain(client_as(user_a), decision_id)
    context = script.sent[0]["context"]
    assert context["facts"][1] == {
        "label": "401(k) contribution rate your latest pay stub shows",
        "value": "5%",
    }
    assert context["notes"] == [STUB_SAME_NOTE]


def test_fallback_states_the_pay_stub_rate(
    script: Script, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    confirm_stub(db_connection, user_a)
    decision_id = save(client_as(user_a), ISSUE_132)
    script(REFUSAL_REPLY)
    out = explain(client_as(user_a), decision_id)
    assert (out["fallback"], out["prompt_version"]) == (True, "fallback/v2")
    assert "Your latest pay stub shows 3% going to your 401(k)" in out["text"]
    assert "already" not in out["text"]


def test_gateway_error_falls_back(
    script: Script, client_as: Client, user_a: FixtureUser, decision: str, db_connection: Connection
) -> None:
    script(REFUSAL_REPLY)
    out = explain(client_as(user_a), decision)
    assert (out["attempt"], out["retries"], out["fallback"]) == (1, 0, True)
    assert rows(db_connection, decision) == [(1, 0, False, True, "fallback/v2")]
    # The refusal is in the ledger.
    statuses = db_connection.execute(
        text("SELECT status::text FROM llm_calls WHERE user_id = :u AND purpose = 'explain'"),
        {"u": user_a.id},
    ).scalars()
    assert list(statuses) == ["refusal"]


def test_idempotent_post(
    script: Script, client_as: Client, user_a: FixtureUser, decision: str, db_connection: Connection
) -> None:
    script(GOOD)
    first = explain(client_as(user_a), decision)
    # An exhausted script would fail the call: none is made.
    second = explain(client_as(user_a), decision)
    assert second["id"] == first["id"]
    assert len(rows(db_connection, decision)) == 1


def test_only_fallbacks_are_retried(
    script: Script, client_as: Client, user_a: FixtureUser, decision: str, db_connection: Connection
) -> None:
    script(REFUSAL_REPLY)
    explain(client_as(user_a), decision)
    script(GOOD)
    out = explain(client_as(user_a), decision)
    assert out["verified"] is True
    assert len(rows(db_connection, decision)) == 2


def test_force_regenerates(
    script: Script, client_as: Client, user_a: FixtureUser, decision: str, db_connection: Connection
) -> None:
    script(GOOD, GOOD)
    first = explain(client_as(user_a), decision)
    forced = explain(client_as(user_a), decision, force=True)
    assert forced["id"] != first["id"]
    assert forced["verified"] is True
    assert len(rows(db_connection, decision)) == 2
    latest = client_as(user_a).get(f"/decisions/{decision}/explanation")
    assert latest.json()["id"] == forced["id"]


def test_get_explanation(
    script: Script, client_as: Client, user_a: FixtureUser, decision: str
) -> None:
    script(BAD, BAD)
    posted = explain(client_as(user_a), decision)
    response = client_as(user_a).get(f"/decisions/{decision}/explanation")
    assert response.status_code == 200
    assert response.json() == posted


def test_get_explanation_404_when_none(
    client_as: Client, user_a: FixtureUser, decision: str
) -> None:
    response = client_as(user_a).get(f"/decisions/{decision}/explanation")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_another_users_decision_is_404(
    script: Script, client_as: Client, user_b: FixtureUser, decision: str
) -> None:
    script()
    response = client_as(user_b).post("/explain", json={"decision_id": decision})
    assert response.status_code == 404
    assert client_as(user_b).get(f"/decisions/{decision}/explanation").status_code == 404


def test_benefits_passages_reach_the_model(
    script: Script, client_as: Client, user_a: FixtureUser, decision: str, db_connection: Connection
) -> None:
    document = make_document(db_connection, user_a.id, type="benefits", with_blob=False)
    with user_session_for(user_a.id, bind=db_connection) as session:
        for index, body in enumerate(
            [
                "Employer matching contributions vest after one year of service.",
                "Dental coverage includes two cleanings a year.",
            ]
        ):
            session.execute(
                text(
                    "INSERT INTO benefits_chunks (user_id, document_id, chunk_index, text)"
                    " VALUES (:u, :d, :i, :t)"
                ),
                {"u": user_a.id, "d": document, "i": index, "t": body},
            )
    script(GOOD)
    explain(client_as(user_a), decision)
    passages = script.sent[0]["context"]["benefits_passages"]
    assert passages == ["Employer matching contributions vest after one year of service."]


def test_without_seeded_citations_the_fallback_is_uncited(
    script: Script, client_as: Client, user_a: FixtureUser, decision: str, db_connection: Connection
) -> None:
    db_connection.execute(text("DELETE FROM irs_citations"))
    script(GOOD, GOOD)
    out = explain(client_as(user_a), decision)
    assert out["fallback"] is True
    assert out["citations"] == []
    assert len(rows(db_connection, decision)) == 3


def test_rate_limit_is_thirty_runs_per_clock_hour(
    script: Script,
    app: FastAPI,
    client_as: Client,
    user_a: FixtureUser,
    user_b: FixtureUser,
    decision: str,
    db_connection: Connection,
) -> None:
    clock = [dt.datetime(2026, 10, 21, 14, 59, 30, tzinfo=dt.UTC)]
    app.dependency_overrides[get_now] = lambda: clock[0]
    script(*[GOOD] * 32)
    client = client_as(user_a)
    for _ in range(30):
        explain(client, decision, force=True)
    # A stored verified explanation and a 404 start no run and do not count.
    explain(client, decision)
    assert client_as(user_b).post("/explain", json={"decision_id": decision}).status_code == 404
    refused = client.post("/explain", json={"decision_id": decision, "force": True})
    assert refused.status_code == 429
    assert refused.json()["error"]["code"] == "rate_limited"
    assert refused.headers["Retry-After"] == "30"
    assert len(rows(db_connection, decision)) == 30
    # Another user has their own limit; the next clock hour starts a new window.
    explain(client_as(user_b), save_decision(client_as(user_b)), force=True)
    clock[0] = dt.datetime(2026, 10, 21, 15, 0, 0, tzinfo=dt.UTC)
    explain(client, decision, force=True)
    assert len(rows(db_connection, decision)) == 31


def test_unconfigured_llm_does_not_count_against_the_limit(
    script: Script, app: FastAPI, client_as: Client, user_a: FixtureUser, decision: str
) -> None:
    app.dependency_overrides[get_now] = lambda: dt.datetime(2026, 10, 21, 14, 0, tzinfo=dt.UTC)
    app.dependency_overrides[get_settings] = lambda: Settings(
        _env_file=None, llm_fake=False, anthropic_api_key=None
    )
    for _ in range(31):
        response = client_as(user_a).post("/explain", json={"decision_id": decision})
        assert response.status_code == 503
    script(GOOD)
    assert explain(client_as(user_a), decision)["verified"] is True


@pytest.fixture
def no_llm(app: FastAPI) -> Iterator[None]:
    settings = Settings(_env_file=None, llm_fake=False, anthropic_api_key=None)
    app.dependency_overrides[get_settings] = lambda: settings
    yield
    app.dependency_overrides.pop(get_settings)


def test_unconfigured_llm_is_503(
    no_llm: None, client_as: Client, user_a: FixtureUser, decision: str
) -> None:
    response = client_as(user_a).post("/explain", json={"decision_id": decision})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "llm_unavailable"


def test_unconfigured_llm_still_returns_a_stored_explanation(
    script: Script, app: FastAPI, client_as: Client, user_a: FixtureUser, decision: str
) -> None:
    script(GOOD)
    first = explain(client_as(user_a), decision)
    app.dependency_overrides.pop(get_llm_gateway)
    app.dependency_overrides[get_settings] = lambda: Settings(
        _env_file=None, llm_fake=False, anthropic_api_key=None
    )
    assert explain(client_as(user_a), decision)["id"] == first["id"]


def test_configured_gateway_is_built_from_settings(
    app: FastAPI,
    client_as: Client,
    user_a: FixtureUser,
    decision: str,
    seeded_citations: Connection,
) -> None:
    """Without an override the route builds the gateway from settings (FakeGateway in tests)."""
    app.dependency_overrides[get_settings] = lambda: Settings(
        _env_file=None, llm_fake=True, anthropic_api_key=SecretStr("unused")
    )
    out = explain(client_as(user_a), decision)
    assert out["verified"] is True


# ---------------------------------------------------------------- M6 calculators


def save_other(client: TestClient, calculator: str, route: str, inputs: dict[str, Any]) -> str:
    result = client.post(route, json=inputs)
    assert result.status_code == 200, result.text
    saved = client.post(
        "/decisions", json={"calculator": calculator, "inputs": inputs, "result": result.json()}
    )
    assert saved.status_code == 201, saved.text
    decision_id: str = saved.json()["decision_id"]
    return decision_id


def test_health_plan_decision_is_explained_with_benefits_text(
    script: Script, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    """Spec 012 rule 16: plan facts, HSA citations and the benefits passages."""
    client = client_as(user_a)
    inputs = health_payload([A, B_TWIN], 6_500_000, 100_000, selected_plan_index=0)
    decision_id = save_other(client, "health_plans", "/calc/health-plans", inputs)
    document = make_document(db_connection, user_a.id, type="benefits", with_blob=False)
    with user_session_for(user_a.id, bind=db_connection) as session:
        session.execute(
            text(
                "INSERT INTO benefits_chunks (user_id, document_id, chunk_index, text)"
                " VALUES (:u, :d, 0, :t)"
            ),
            {"u": user_a.id, "d": document, "t": "Bronze HSA deductible and coinsurance."},
        )
    script(GOOD)
    out = explain(client, decision_id)
    assert (out["verified"], out["fallback"]) == (True, False)
    assert out["citations"][0]["key"] == "health.hdhp_definition"
    context = script.sent[0]["context"]
    assert context["calculator"] == "health_plans"
    assert context["benefits_passages"] == ["Bronze HSA deductible and coinsurance."]


def test_health_plan_fallback_is_cited(
    script: Script, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    inputs = health_payload([A, B], 6_500_000, 100_000, selected_plan_index=1)
    decision_id = save_other(client, "health_plans", "/calc/health-plans", inputs)
    script(BAD, BAD)
    out = explain(client, decision_id)
    assert (out["fallback"], out["prompt_version"]) == (True, "fallback/v2")
    assert [c["key"] for c in out["citations"]] == [
        "health.hdhp_definition",
        "health.hsa_limit",
        "health.federal_brackets",
    ]
    assert "Gold PPO" in out["text"]


def test_emergency_fund_decision_is_not_explained_yet(
    script: Script, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    """Spec 011, out of scope: no IRS passage applies, so no run starts."""
    client = client_as(user_a)
    decision_id = save_other(
        client, "emergency_fund", "/calc/emergency-fund", EMERGENCY_FUND_INPUTS
    )
    script(GOOD)
    response = client.post("/explain", json={"decision_id": decision_id})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "explanation_unavailable"
    assert script.sent == []
    assert rows(db_connection, decision_id) == []
    assert client.get(f"/decisions/{decision_id}/explanation").status_code == 404


# Spec 014 example 5: a second job and no Step 2, so a balance due.
W4_EXAMPLE_5: dict[str, Any] = {
    "salary_cents": 5_000_000,
    "pay_periods_per_year": 26,
    "filing_status": "single",
    "tax_year": 2026,
    "other_jobs_wages_cents": 2_000_000,
    "other_jobs_withholding_cents": 39_000,
}


def test_w4_decision_is_explained_with_its_citations(
    script: Script, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    """Spec 014 rule 19: W-4 facts, notes and the seeded w4 passages."""
    client = client_as(user_a)
    decision_id = save_other(client, "w4", "/calc/w4", W4_EXAMPLE_5)
    script(GOOD)
    out = explain(client, decision_id)
    assert (out["verified"], out["fallback"]) == (True, False)
    assert out["citations"][0]["key"] == "w4.percentage_method"
    assert out["citations"][0]["url"] == "https://www.irs.gov/publications/p15t"
    context = script.sent[0]["context"]
    assert context["calculator"] == "w4"
    assert [c["key"] for c in context["citations"]][:5] == [
        "w4.percentage_method",
        "w4.form_adjustments",
        "w4.standard_deduction",
        "w4.federal_brackets",
        "w4.multiple_jobs",
    ]
    facts = {fact["label"]: fact["value"] for fact in context["facts"]}
    assert facts["Projected balance due"] == "$2,360.08"
    assert rows(db_connection, decision_id) == [(1, 0, True, False, "explain/v2")]


def test_w4_fallback_is_cited(script: Script, client_as: Client, user_a: FixtureUser) -> None:
    client = client_as(user_a)
    decision_id = save_other(client, "w4", "/calc/w4", W4_EXAMPLE_5)
    script(BAD, BAD)
    out = explain(client, decision_id)
    assert (out["fallback"], out["prompt_version"]) == (True, "fallback/v2")
    assert out["verification"]["numbers_unmatched"] == []
    assert [c["key"] for c in out["citations"]] == [
        "w4.percentage_method",
        "w4.form_adjustments",
        "w4.standard_deduction",
        "w4.federal_brackets",
        "w4.multiple_jobs",
    ]
    assert "owe about $2,360.08" in out["text"]
