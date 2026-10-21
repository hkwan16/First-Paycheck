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
from tests.conftest import FixtureUser
from tests.support.factories import make_document

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
    assert out["prompt_version"] == "explain/v1"
    assert out["verification"]["numbers_unmatched"] == []
    assert out["verification"]["has_citation"] is True
    [citation] = out["citations"]
    assert citation["key"] == script.sent[0]["context"]["citations"][0]["key"]
    assert citation["url"].startswith("https://www.irs.gov/")
    assert citation["passage"]
    assert rows(db_connection, decision) == [(1, 0, True, False, "explain/v1")]
    # The model saw the decision's facts and no feedback.
    context = script.sent[0]["context"]
    assert {"label": "Match you miss per year", "value": "$600.00"} in context["facts"]
    assert "feedback" not in script.sent[0]


def test_fail_then_pass(
    script: Script, client_as: Client, user_a: FixtureUser, decision: str, db_connection: Connection
) -> None:
    script(BAD, GOOD)
    out = explain(client_as(user_a), decision)
    assert (out["attempt"], out["retries"], out["verified"], out["fallback"]) == (2, 1, True, False)
    assert rows(db_connection, decision) == [
        (1, 0, False, False, "explain/v1"),
        (2, 1, True, False, "explain/v1"),
    ]
    assert "$123,456.78" in script.sent[1]["feedback"]


def test_fail_twice_falls_back(
    script: Script, client_as: Client, user_a: FixtureUser, decision: str, db_connection: Connection
) -> None:
    script(BAD, BAD)
    out = explain(client_as(user_a), decision)
    assert (out["attempt"], out["retries"], out["verified"], out["fallback"]) == (3, 1, False, True)
    assert out["prompt_version"] == "fallback/v1"
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
        (1, 0, False, False, "explain/v1"),
        (2, 1, False, False, "explain/v1"),
        (3, 1, False, True, "fallback/v1"),
    ]


def test_gateway_error_falls_back(
    script: Script, client_as: Client, user_a: FixtureUser, decision: str, db_connection: Connection
) -> None:
    script(REFUSAL_REPLY)
    out = explain(client_as(user_a), decision)
    assert (out["attempt"], out["retries"], out["fallback"]) == (1, 0, True)
    assert rows(db_connection, decision) == [(1, 0, False, True, "fallback/v1")]
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
