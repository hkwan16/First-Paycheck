"""A user's synced transactions, labeled the way the worker labels them
(spec 003 rules 3d and 9a; issues #148 and #146).

Each test links a bank item, runs the worker as production does (the sync job
writes the transactions and queues ``categorize.run``, which runs the seed
rules and then the gateway as the user, under RLS) and reads the categories
back through ``GET /transactions`` as the user sees them.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Sequence

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Connection, text

from app.db import user_session_for
from db.enums import JobKind
from jobs import queue
from jobs.context import Services
from jobs.registry import default_handlers
from jobs.worker import Worker
from llm.gateway import CategorizeItem
from llm.schemas import CategoryAssignment, CategoryBatch
from sync.categories import Category
from sync.categorize import CategoryLabeler
from sync.pipeline import SyncItemSecrets
from sync.provider import ProviderTransaction, SyncProvider
from tests.conftest import FixtureUser
from tests.support.anthropic_api import AnsweringApi, api_gateway
from tests.support.factories import make_item
from tests.support.fake_provider import CHECKING, FakeProvider, page, txn

Client = Callable[[FixtureUser], TestClient]


class ScriptedLabeler:
    """Answers each merchant from a map; records which merchants it was asked."""

    def __init__(self, answers: dict[str, Category]) -> None:
        self.answers = answers
        self.merchants: list[str] = []

    def categorize(
        self,
        user_id: uuid.UUID,
        items: Sequence[CategorizeItem],
        *,
        job_id: uuid.UUID | None = None,
    ) -> CategoryBatch:
        self.merchants.extend(item.merchant for item in items)
        return CategoryBatch(
            items=[
                CategoryAssignment(id=item.id, category=self.answers[item.merchant], confidence=0.9)
                for item in items
                if item.merchant in self.answers
            ]
        )


@pytest.fixture
def empty_queue(seeded_rules: Connection) -> Connection:
    seeded_rules.execute(text("DELETE FROM jobs"))
    return seeded_rules


def sync_and_categorize(
    connection: Connection,
    user: FixtureUser,
    added: Sequence[ProviderTransaction],
    labeler: CategoryLabeler,
) -> None:
    """Link an item and run every job its first sync queues, as the worker does."""
    item = make_item(connection, user.id)
    with user_session_for(user.id, bind=connection) as session:
        queue.enqueue(
            session,
            user_id=user.id,
            kind=JobKind.SYNC_INITIAL,
            payload={"sync_item_id": str(item)},
        )

    def provider_for(secrets: SyncItemSecrets) -> SyncProvider:
        return FakeProvider(accounts=[CHECKING], pages={None: page("c1", added=added)})

    worker = Worker(
        handlers=default_handlers(),
        services=Services(provider_for=provider_for, labeler=labeler),
        queue_bind=connection,
        user_bind=connection,
    )
    for _ in range(10):
        if not worker.run_once():
            break
    failed = connection.execute(
        text("SELECT kind::text, last_error FROM jobs WHERE status <> 'succeeded'")
    ).all()
    assert failed == []
    kinds = connection.execute(text("SELECT kind::text FROM jobs")).scalars()
    assert "categorize.run" in set(kinds)


def categories(client: TestClient) -> dict[str, tuple[str | None, str | None]]:
    """What the user sees: ``merchant_norm`` to (category, category_source)."""
    response = client.get("/transactions", params={"limit": 200})
    assert response.status_code == 200, response.text
    return {
        row["merchant_norm"]: (row["category"], row["category_source"])
        for row in response.json()["items"]
    }


def test_a_seed_word_inside_another_merchants_name_is_not_its_category(
    empty_queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    """Issue #148: the seed prefix rules ``rent``, ``shell`` and ``target`` labeled
    Rent the Runway housing, a surf shop transport and Target Optical shopping,
    and the model never saw them. Each is now its own merchant (spec 003 rule 3d)."""
    labeler = ScriptedLabeler({"rent the runway": "shopping", "shell beach surf shop": "shopping"})
    sync_and_categorize(
        empty_queue,
        user_a,
        [
            txn("t1", 8_500, "RENT THE RUNWAY AB123"),
            txn("t2", 4_500, "SHELL BEACH SURF SHOP"),
            txn("t3", 18_000, "TARGET OPTICAL 00123"),
            txn("t4", 4_800, "SHELL OIL 57442"),
            txn("t5", 4_200, "TARGET 00012345"),
            txn("t6", 210_000, "RENT PAYMENT AB123"),
        ],
        labeler,
    )

    assert categories(client_as(user_a)) == {
        "rent the runway": ("shopping", "llm"),
        "shell beach surf shop": ("shopping", "llm"),
        "target optical": ("healthcare", "rule"),
        "shell oil": ("transport", "rule"),
        "target": ("shopping", "rule"),
        "rent payment": ("housing", "rule"),
    }
    # Only the merchants no seed rule names reach the model.
    assert sorted(labeler.merchants) == ["rent the runway", "shell beach surf shop"]


def test_a_public_radio_membership_is_sent_with_the_donation_definition(
    empty_queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    """Issue #146: categorize/v2 listed memberships under subscriptions, so the
    model called a public radio station's member dues a subscription. The job
    now sends categorize/v3, which defines such a membership as a donation
    (spec 003 rule 9a), and applies the model's answer to the user's rows."""
    api = AnsweringApi({"items": [{"id": 1, "category": "gifts_donations", "confidence": 0.92}]})
    sync_and_categorize(
        empty_queue,
        user_a,
        [txn("t1", 2_500, "KQED MEMBERSHIP"), txn("t2", 1_200, "SAFEWAY #1234")],
        api_gateway(empty_queue, api),
    )

    [request] = api.requests
    system = request["system"][0]["text"]
    assert "public radio" in system
    versions = empty_queue.execute(
        text("SELECT prompt_version FROM llm_calls WHERE user_id = :u"), {"u": user_a.id}
    ).scalars()
    assert list(versions) == ["categorize/v3"]
    assert categories(client_as(user_a)) == {
        "kqed membership": ("gifts_donations", "llm"),
        "safeway": ("groceries", "rule"),
    }
