"""An explanation written from facts that have changed since reads as out of
date (spec 008 rule 19a, issue 161).

Issue 161's account: a verified 401(k) explanation written before the newest
pay stub's rate was part of the context said "You are already contributing
5%" beside a stub at 3%, and ``GET /decisions/{id}/explanation`` kept
returning it as the verified answer. Each test writes an explanation from one
context, changes what the decision would be explained from now, and reads.
"""

from __future__ import annotations

import datetime as dt
import re
import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Connection, text

from app.db import user_session_for
from db.models import Explanation
from tests.conftest import FixtureUser
from tests.integration.test_explain import (
    BAD,
    GOOD,
    ISSUE_132,
    Script,
    confirm_stub,
    explain,
    save,
)
from tests.support.factories import make_document

Client = Callable[[FixtureUser], TestClient]

# The 5.00 stub of test_the_newest_stub_gives_the_rate: 18,269 of 365,385.
LATER_AT_FIVE: dict[str, Any] = {
    "pay_date": dt.date(2026, 4, 24),
    "period_start": dt.date(2026, 4, 6),
    "period_end": dt.date(2026, 4, 19),
    "retirement_contribution_cents": 18_269,
    "net_cents": 275_086 - (18_269 - 10_962),
}
LATER_AT_THREE: dict[str, Any] = {
    "pay_date": dt.date(2026, 4, 24),
    "period_start": dt.date(2026, 4, 6),
    "period_end": dt.date(2026, 4, 19),
}


@pytest.fixture
def script(app: FastAPI, db_connection: Connection, seeded_citations: Connection) -> Script:
    return Script(app, db_connection)


def read(client: TestClient, decision_id: str) -> dict[str, Any]:
    response = client.get(f"/decisions/{decision_id}/explanation")
    assert response.status_code == 200, response.text
    out: dict[str, Any] = response.json()
    return out


def digests(connection: Connection, decision_id: str) -> list[str | None]:
    return list(
        connection.execute(
            text(
                "SELECT context_digest FROM explanations WHERE decision_id = :d"
                " ORDER BY created_at, attempt"
            ),
            {"d": decision_id},
        ).scalars()
    )


def run_count(connection: Connection, decision_id: str) -> int:
    count = connection.execute(
        text("SELECT count(*) FROM explanations WHERE decision_id = :d"), {"d": decision_id}
    ).scalar_one()
    return int(count)


def add_chunk(connection: Connection, user: FixtureUser, body: str) -> None:
    document = make_document(connection, user.id, type="benefits", with_blob=False)
    with user_session_for(user.id, bind=connection) as session:
        session.execute(
            text(
                "INSERT INTO benefits_chunks (user_id, document_id, chunk_index, text)"
                " VALUES (:u, :d, 0, :t)"
            ),
            {"u": user.id, "d": document, "t": body},
        )


def write_row(
    connection: Connection,
    user: FixtureUser,
    decision_id: str,
    *,
    prompt_version: str,
    context_digest: str | None,
) -> uuid.UUID:
    """A verified row written directly, as a run of older code left it."""
    with user_session_for(user.id, bind=connection) as session:
        row = Explanation(
            user_id=user.id,
            decision_id=uuid.UUID(decision_id),
            attempt=1,
            retries=0,
            concept="Your employer matches what you put into your 401(k).",
            text="You are already contributing 5%, so you get the $3,800.00 match now.",
            numbers=[],
            what_ifs=[],
            citations=["k401.employer_match"],
            prompt_version=prompt_version,
            verified=True,
            fallback=False,
            verification={
                "numbers_checked": 2,
                "numbers_unmatched": [],
                "citations_checked": 1,
                "citations_unknown": [],
                "has_citation": True,
            },
            context_digest=context_digest,
        )
        session.add(row)
        session.flush()
        return row.id


def test_explained_before_any_stub_is_stale_once_one_is_confirmed(
    script: Script, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    client = client_as(user_a)
    decision_id = save(client, ISSUE_132)
    script(GOOD, GOOD)
    written = explain(client, decision_id)
    assert written["stale"] is False
    assert read(client, decision_id)["stale"] is False

    confirm_stub(db_connection, user_a)
    stale = read(client, decision_id)
    # The same row, as it was written, now flagged.
    assert stale["id"] == written["id"]
    assert stale["text"] == written["text"]
    assert stale["verified"] is True
    assert stale["stale"] is True

    # Asking again without force writes it from the stub's rate.
    again = explain(client, decision_id)
    assert again["id"] != written["id"]
    assert again["stale"] is False
    assert script.sent[1]["context"]["facts"][1] == {
        "label": "401(k) contribution rate your latest pay stub shows",
        "value": "3%",
    }
    assert read(client, decision_id) == again


def test_a_newer_stub_with_another_rate_makes_it_stale(
    script: Script, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    client = client_as(user_a)
    confirm_stub(db_connection, user_a)
    decision_id = save(client, ISSUE_132)
    script(GOOD, GOOD)
    explain(client, decision_id)
    confirm_stub(db_connection, user_a, **LATER_AT_FIVE)
    assert read(client, decision_id)["stale"] is True
    explain(client, decision_id)
    assert run_count(db_connection, decision_id) == 2


def test_a_newer_stub_with_the_same_rate_keeps_it_current(
    script: Script, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    client = client_as(user_a)
    confirm_stub(db_connection, user_a)
    decision_id = save(client, ISSUE_132)
    script(GOOD)
    written = explain(client, decision_id)
    confirm_stub(db_connection, user_a, **LATER_AT_THREE)
    assert read(client, decision_id)["stale"] is False
    # An exhausted script would fail a run: none starts.
    assert explain(client, decision_id)["id"] == written["id"]
    assert run_count(db_connection, decision_id) == 1


def test_a_benefits_summary_makes_it_stale(
    script: Script, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    client = client_as(user_a)
    confirm_stub(db_connection, user_a)
    decision_id = save(client, ISSUE_132)
    script(GOOD, GOOD)
    explain(client, decision_id)
    add_chunk(db_connection, user_a, "Employer matching contributions vest after one year.")
    assert read(client, decision_id)["stale"] is True
    explain(client, decision_id)
    assert script.sent[1]["context"]["benefits_passages"] == [
        "Employer matching contributions vest after one year."
    ]


def test_a_row_without_a_digest_is_stale(
    script: Script, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    """Issue 161 as production has it: an explain/v1 row from before 0019."""
    client = client_as(user_a)
    confirm_stub(db_connection, user_a)
    decision_id = save(client, ISSUE_132)
    old = write_row(
        db_connection, user_a, decision_id, prompt_version="explain/v1", context_digest=None
    )
    out = read(client, decision_id)
    assert (out["id"], out["verified"], out["stale"]) == (str(old), True, True)
    script(GOOD)
    again = explain(client, decision_id)
    assert again["id"] != str(old)
    assert again["stale"] is False


def test_an_older_prompt_version_is_stale(
    script: Script, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    client = client_as(user_a)
    confirm_stub(db_connection, user_a)
    decision_id = save(client, ISSUE_132)
    script(GOOD, GOOD)
    explain(client, decision_id)
    [current] = digests(db_connection, decision_id)
    write_row(
        db_connection, user_a, decision_id, prompt_version="explain/v1", context_digest=current
    )
    assert read(client, decision_id)["stale"] is True
    assert explain(client, decision_id)["stale"] is False
    assert run_count(db_connection, decision_id) == 3


def test_a_fresh_run_is_current(
    script: Script, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    client = client_as(user_a)
    confirm_stub(db_connection, user_a)
    decision_id = save(client, ISSUE_132)
    # A failing draft, then a good one: one run, two rows.
    script(BAD, GOOD)
    written = explain(client, decision_id)
    assert (written["attempt"], written["stale"]) == (2, False)
    first, second = digests(db_connection, decision_id)
    assert first == second
    assert first is not None
    assert re.fullmatch(r"[0-9a-f]{64}", first)
    assert explain(client, decision_id)["id"] == written["id"]


def test_plan_reports_a_stale_explanation(
    script: Script, client_as: Client, user_a: FixtureUser, db_connection: Connection
) -> None:
    client = client_as(user_a)
    decision_id = save(client, ISSUE_132)
    script(GOOD)
    explain(client, decision_id)

    def k401() -> dict[str, Any]:
        plan = client.get("/plan")
        assert plan.status_code == 200, plan.text
        [decision] = [d for d in plan.json()["decisions"] if d["id"] == decision_id]
        explanation: dict[str, Any] = decision["explanation"]
        return explanation

    assert (k401()["status"], k401()["stale"]) == ("verified", False)
    confirm_stub(db_connection, user_a)
    assert (k401()["status"], k401()["stale"]) == ("verified", True)
