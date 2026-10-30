"""Benefits summaries: the match and vesting in the proposal, confirm into
plans and the profile, and GET /benefits-plans (spec 013)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Connection, func, select, text
from sqlalchemy import table as sa_table

from tests.conftest import FixtureUser
from tests.integration.test_docs_flow import PLAN, extracted, uploaded
from tests.support.documents import text_pdf

Client = Callable[[FixtureUser], TestClient]

SUMMARY_PDF = text_pdf(
    [
        [
            "Acme Corp 2027 Benefits Summary",
            "Bronze HSA (high deductible)",
            "Gold PPO",
            "401(k) match: 100% of the first 3% of pay you contribute",
            "plus 50% of the next 2%",
            "Employer contributions vest after 3 years of service",
        ]
    ]
)
BRONZE: dict[str, Any] = {
    **PLAN,
    "name": "Bronze HSA",
    "kind": "hdhp",
    "premium_per_period_cents": 2_500,
    "deductible_cents": 170_000,
    "oop_max_cents": 400_000,
    "coinsurance_pct": "20",
    "employer_hsa_cents": 75_000,
}
TIERS = [
    {"employee_pct_upto": "3", "employer_pct": "100"},
    {"employee_pct_upto": "5", "employer_pct": "50"},
]


@pytest.fixture
def empty_queue(db_connection: Connection) -> Connection:
    db_connection.execute(text("DELETE FROM jobs"))
    return db_connection


def proposed(client: TestClient, connection: Connection) -> str:
    document_id = uploaded(client, SUMMARY_PDF, type="benefits")
    detail = extracted(client, connection, document_id)
    assert detail["status"] == "proposed"
    return document_id


def confirm(client: TestClient, document_id: str, benefits: dict[str, Any]) -> Any:
    return client.post(f"/docs/{document_id}/confirm", json={"benefits": benefits})


def count(connection: Connection, name: str) -> int:
    return int(connection.execute(select(func.count()).select_from(sa_table(name))).scalar_one())


def test_proposal_shows_the_match_and_vesting(
    empty_queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    document_id = uploaded(client, SUMMARY_PDF, type="benefits")
    proposal = extracted(client, empty_queue, document_id)["proposal"]
    assert proposal["kind"] == "benefits"
    bounds = [
        {field["key"]: field["value"] for field in tier["fields"]}
        for tier in proposal["match_tiers"]
    ]
    assert bounds == [
        {"employee_pct_upto": "3.00", "employer_pct": "100.00"},
        {"employee_pct_upto": "5.00", "employer_pct": "50.00"},
    ]
    assert proposal["vesting_years"]["value"] == 3
    assert len(proposal["plans"]) == 2


def test_pay_stub_proposal_kind(
    empty_queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    document_id = uploaded(client)
    assert extracted(client, empty_queue, document_id)["proposal"]["kind"] == "pay_stub"


def test_confirm_writes_plans_profile_and_chunks(
    empty_queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    assert (
        client.put("/profile", json={"salary_cents": 6_500_000, "dependents": 1}).status_code == 200
    )
    document_id = proposed(client, empty_queue)
    response = confirm(
        client,
        document_id,
        {"plans": [BRONZE, PLAN], "retirement": {"match_tiers": TIERS, "vesting_years": 3}},
    )
    assert response.status_code == 200, response.text
    assert response.json()["profile_updated"] is True
    profile = client.get("/profile").json()
    assert profile["match_tiers"] == [
        {"employee_pct_upto": "3.00", "employer_pct": "100.00"},
        {"employee_pct_upto": "5.00", "employer_pct": "50.00"},
    ]
    assert profile["vesting_years"] == 3
    assert (profile["salary_cents"], profile["dependents"]) == (6_500_000, 1)
    plans = client.get("/benefits-plans").json()
    assert [(plan["name"], plan["document_id"]) for plan in plans] == [
        ("Bronze HSA", document_id),
        ("Gold PPO", document_id),
    ]
    assert plans[0]["employer_hsa_cents"] == 75_000
    assert count(empty_queue, "benefits_chunks") == 1


def test_confirm_without_retirement_leaves_the_profile(
    empty_queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    assert client.put("/profile", json={"match_tiers": [TIERS[0]]}).status_code == 200
    document_id = proposed(client, empty_queue)
    response = confirm(client, document_id, {"plans": [PLAN]})
    assert response.status_code == 200, response.text
    assert response.json()["profile_updated"] is False
    assert client.get("/profile").json()["match_tiers"] == [
        {"employee_pct_upto": "3.00", "employer_pct": "100.00"}
    ]


def test_retirement_only_summary(
    empty_queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    document_id = proposed(client, empty_queue)
    retirement = {"match_tiers": [{"employee_pct_upto": "6", "employer_pct": "50"}]}
    response = confirm(client, document_id, {"plans": [], "retirement": retirement})
    assert response.status_code == 200, response.text
    assert count(empty_queue, "benefits_plans") == 0
    profile = client.get("/profile").json()
    assert profile["match_tiers"] == [{"employee_pct_upto": "6.00", "employer_pct": "50.00"}]
    assert profile["vesting_years"] is None


@pytest.mark.parametrize(
    "benefits",
    [
        {"plans": []},
        {"plans": [{**PLAN, "employer_hsa_cents": 50_000}]},
        {"plans": [PLAN], "retirement": {"match_tiers": TIERS[::-1]}},
    ],
    ids=["empty_body", "employer_hsa_on_a_ppo", "tiers_must_ascend"],
)
def test_bad_confirm_is_422(
    empty_queue: Connection, client_as: Client, user_a: FixtureUser, benefits: dict[str, Any]
) -> None:
    client = client_as(user_a)
    document_id = proposed(client, empty_queue)
    response = confirm(client, document_id, benefits)
    assert response.status_code == 422, response.text
    assert count(empty_queue, "benefits_plans") == 0
    assert count(empty_queue, "benefits_chunks") == 0
    assert client.get("/profile").json()["updated_at"] is None
    assert client.get(f"/docs/{document_id}").json()["status"] == "proposed"


def test_a_typed_deductible_over_the_maximum_is_refused_in_words(
    empty_queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    """Spec 008 rule 22a: the Confirm screen shows this message as it is."""
    client = client_as(user_a)
    document_id = proposed(client, empty_queue)
    response = confirm(client, document_id, {"plans": [{**PLAN, "deductible_cents": 900_000}]})
    assert response.status_code == 422, response.text
    assert response.json()["error"] == {
        "code": "validation_error",
        "message": "A plan's deductible must not be more than its out-of-pocket maximum",
    }


def test_newest_document_first(
    empty_queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    client = client_as(user_a)
    first = proposed(client, empty_queue)
    assert confirm(client, first, {"plans": [BRONZE, PLAN]}).status_code == 200
    second = proposed(client, empty_queue)
    silver = {**PLAN, "name": "Silver HMO", "kind": "hmo"}
    assert confirm(client, second, {"plans": [silver, PLAN]}).status_code == 200
    plans = client.get("/benefits-plans").json()
    assert [(plan["name"], plan["document_id"]) for plan in plans] == [
        ("Silver HMO", second),
        ("Gold PPO", second),
        ("Bronze HSA", first),
        ("Gold PPO", first),
    ]


def test_no_plans_yet(client_as: Client, user_a: FixtureUser) -> None:
    assert client_as(user_a).get("/benefits-plans").json() == []
