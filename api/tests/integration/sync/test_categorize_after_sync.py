"""A user's synced transactions, labeled the way the worker labels them
(spec 003 rules 3d and 9a; issues #148 and #146).

Each test links a bank item, runs the worker as production does (the sync job
writes the transactions and queues ``categorize.run``, which runs the seed
rules and then the gateway as the user, under RLS) and reads the categories
back through ``GET /transactions`` as the user sees them.
"""

from __future__ import annotations

import datetime as dt
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

    run_worker(
        connection,
        FakeProvider(accounts=[CHECKING], pages={None: page("c1", added=added)}),
        labeler,
    )


def run_worker(connection: Connection, provider: SyncProvider, labeler: CategoryLabeler) -> None:
    """Run every queued job, as the worker does, and check they all succeeded."""

    def provider_for(secrets: SyncItemSecrets) -> SyncProvider:
        return provider

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
    now sends categorize/v4, which keeps v3's definition of such a membership as
    a donation (spec 003 rule 9a), and applies the model's answer to the user's
    rows."""
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
    assert list(versions) == ["categorize/v4"]
    assert categories(client_as(user_a)) == {
        "kqed membership": ("gifts_donations", "llm"),
        "safeway": ("groceries", "rule"),
    }


def test_a_tax_refund_deposit_is_income_and_a_tax_payment_is_taxes(
    empty_queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    """Spec 003 rule 9b: the seed prefix rule ``irs treas`` (taxes) applies in
    both directions, so the IRS's refund deposit came back taxes while the
    prompt calls a tax refund income. The seed contains rule ``tax ref`` ranks
    above it for money in."""
    labeler = ScriptedLabeler({})
    sync_and_categorize(
        empty_queue,
        user_a,
        [
            txn("t1", -118_000, "IRS TREAS 310 TAX REF"),
            txn("t2", 52_000, "IRS TREAS 310 TAX PYMT"),
        ],
        labeler,
    )

    assert categories(client_as(user_a)) == {
        "irs treas tax ref": ("income", "rule"),
        "irs treas tax pymt": ("taxes", "rule"),
    }
    assert labeler.merchants == []


BUDGETING_APPS = {"rocket money", "truebill", "ynab", "monarch money", "copilot money", "simplifi"}


def test_an_earlier_guess_follows_a_seed_rule_added_later(
    no_seed_rules: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    """Issue #226: on October 29 the model guessed Rocket Money, a $21.54
    budgeting app charge, was a savings transfer, and it was the whole of the
    month's savings. Rules only ever labeled uncategorized rows and an earlier
    guess was copied to the merchant's new rows, so the guess stayed after the
    model and the rules changed. Spec 003 rules 7 and 9c: the seed rule now
    names the app, and the categorize run every sync queues relabels a guess a
    rule decides, leaving the user's own choice alone."""
    no_seed_rules.execute(text("DELETE FROM jobs"))
    from db.seed.load import load_category_rules, read_seed_rules

    seed = read_seed_rules()
    load_category_rules(no_seed_rules, [r for r in seed if r.merchant_norm not in BUDGETING_APPS])
    item = make_item(no_seed_rules, user_a.id)
    with user_session_for(user_a.id, bind=no_seed_rules) as session:
        queue.enqueue(
            session,
            user_id=user_a.id,
            kind=JobKind.SYNC_INITIAL,
            payload={"sync_item_id": str(item)},
        )
    october = [
        txn("t1", -199_604, "ACME CORP PAYROLL", posted_at=dt.date(2026, 10, 15)),
        txn("t2", 2_154, "Rocket Money", posted_at=dt.date(2026, 10, 28)),
        txn("t3", 4_200, "SAFEWAY #1234", posted_at=dt.date(2026, 10, 20)),
    ]
    provider = FakeProvider(
        accounts=[CHECKING],
        pages={
            None: page("c1", added=october),
            # The next sync brings the app's November charge.
            "c1": page(
                "c2", added=[txn("t4", 2_154, "Rocket Money", posted_at=dt.date(2026, 11, 28))]
            ),
        },
    )
    run_worker(no_seed_rules, provider, ScriptedLabeler({"rocket money": "savings_investment"}))
    client = client_as(user_a)
    # The user puts Safeway under shopping themselves.
    safeway = next(
        row
        for row in client.get("/transactions").json()["items"]
        if row["merchant_norm"] == "safeway"
    )
    assert (
        client.patch(f"/transactions/{safeway['id']}", json={"category": "shopping"}).status_code
        == 200
    )
    october_summary = client.get(
        "/spending/summary", params={"start": "2026-10-01", "end": "2026-10-31"}
    )
    assert october_summary.json()["savings_cents"] == 2_154

    # A deploy loads the new seed rules; the next sync runs the categorize job.
    load_category_rules(no_seed_rules, seed)
    with user_session_for(user_a.id, bind=no_seed_rules) as session:
        queue.enqueue(
            session,
            user_id=user_a.id,
            kind=JobKind.SYNC_INCREMENTAL,
            payload={"sync_item_id": str(item)},
        )
    later = ScriptedLabeler({"rocket money": "savings_investment"})
    run_worker(no_seed_rules, provider, later)

    rows = client.get("/transactions").json()["items"]
    assert sorted(
        (r["merchant_norm"], r["posted_at"], r["category"], r["category_source"]) for r in rows
    ) == [
        ("acme corp payroll", "2026-10-15", "income", "rule"),
        ("rocket money", "2026-10-28", "subscriptions", "rule"),
        ("rocket money", "2026-11-28", "subscriptions", "rule"),
        ("safeway", "2026-10-20", "shopping", "user"),
    ]
    assert later.merchants == []
    october_summary = client.get(
        "/spending/summary", params={"start": "2026-10-01", "end": "2026-10-31"}
    )
    body = october_summary.json()
    assert (body["savings_cents"], body["flexible_cents"]) == (0, 2_154 + 4_200)
    # Every run's result (one transaction, so their created_at is the same).
    results = no_seed_rules.execute(
        text("SELECT result FROM jobs WHERE kind = 'categorize.run' AND status = 'succeeded'")
    ).scalars()
    assert sorted(r["relabeled"] for r in results) == [0, 1]


# The seed rows issue #250 added besides the `cash` ones: the fees beside them.
CASH_FEE_RULES = {"atm withdrawal fee", "cash withdrawal fee"}


def test_an_earlier_transfer_guess_for_a_withdrawal_becomes_cash(
    no_seed_rules: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    """Issue #250: categorize/v3 told the model an ATM withdrawal is a
    transfer, so the cash taken out was left out of the month's spending and
    the left over was too high by it. Spec 003 rule 9d: seed rules name the
    withdrawal descriptors `cash`, a flexible category, and the categorize run
    every sync queues relabels the earlier guess (rule 7). The person's own
    label stays, a transfer between their accounts stays a transfer, and a
    guess no rule names keeps its label."""
    no_seed_rules.execute(text("DELETE FROM jobs"))
    from db.seed.load import load_category_rules, read_seed_rules

    seed = read_seed_rules()
    load_category_rules(
        no_seed_rules,
        [r for r in seed if r.category != "cash" and r.merchant_norm not in CASH_FEE_RULES],
    )
    item = make_item(no_seed_rules, user_a.id)
    with user_session_for(user_a.id, bind=no_seed_rules) as session:
        queue.enqueue(
            session,
            user_id=user_a.id,
            kind=JobKind.SYNC_INITIAL,
            payload={"sync_item_id": str(item)},
        )
    october = [
        txn("t1", -200_000, "ACME CORP PAYROLL", posted_at=dt.date(2026, 10, 15)),
        txn(
            "t2", 6_000, "ATM WITHDRAWAL 001234 10/31 100 MAIN ST", posted_at=dt.date(2026, 10, 31)
        ),
        txn("t3", 30_000, "CASH WITHDRAWAL TELLER 0042", posted_at=dt.date(2026, 10, 20)),
        txn("t4", 20_000, "ONLINE TRANSFER TO SAV 4567", posted_at=dt.date(2026, 10, 16)),
        txn(
            "t5",
            8_000,
            "BKOFAMERICA ATM 10/21 #000004321 WITHDRWL MAIN ST",
            posted_at=dt.date(2026, 10, 21),
        ),
    ]
    provider = FakeProvider(
        accounts=[CHECKING],
        pages={
            None: page("c1", added=october),
            # The next sync brings a November withdrawal at the same ATM.
            "c1": page(
                "c2",
                added=[
                    txn(
                        "t6",
                        4_000,
                        "ATM WITHDRAWAL 005678 11/07 100 MAIN ST",
                        posted_at=dt.date(2026, 11, 7),
                    )
                ],
            ),
        },
    )
    # What categorize/v3's definition of `transfer` told the model.
    v3: dict[str, Category] = {
        "atm withdrawal main st": "transfer",
        "cash withdrawal teller": "transfer",
        "bkofamerica atm withdrwl main st": "transfer",
    }
    run_worker(no_seed_rules, provider, ScriptedLabeler(v3))
    client = client_as(user_a)
    # The person files the teller withdrawal as a transfer themselves (they
    # carried the cash to another bank): their choice, never relabeled.
    teller = next(
        row
        for row in client.get("/transactions").json()["items"]
        if row["merchant_norm"] == "cash withdrawal teller"
    )
    assert (
        client.patch(f"/transactions/{teller['id']}", json={"category": "transfer"}).status_code
        == 200
    )
    october_range = {"start": "2026-10-01", "end": "2026-10-31"}
    body = client.get("/spending/summary", params=october_range).json()
    assert (body["flexible_cents"], body["transfers_ignored_cents"], body["left_over_cents"]) == (
        0,
        6_000 + 30_000 + 20_000 + 8_000,
        200_000,
    )

    # A deploy loads the new seed rules; the next sync runs the categorize job.
    load_category_rules(no_seed_rules, seed)
    with user_session_for(user_a.id, bind=no_seed_rules) as session:
        queue.enqueue(
            session,
            user_id=user_a.id,
            kind=JobKind.SYNC_INCREMENTAL,
            payload={"sync_item_id": str(item)},
        )
    later = ScriptedLabeler(v3)
    run_worker(no_seed_rules, provider, later)

    rows = client.get("/transactions").json()["items"]
    assert sorted(
        (r["merchant_norm"], r["posted_at"], r["category"], r["category_source"]) for r in rows
    ) == [
        ("acme corp payroll", "2026-10-15", "income", "rule"),
        ("atm withdrawal main st", "2026-10-31", "cash", "rule"),
        ("atm withdrawal main st", "2026-11-07", "cash", "rule"),
        ("bkofamerica atm withdrwl main st", "2026-10-21", "transfer", "llm"),
        ("cash withdrawal teller", "2026-10-20", "transfer", "user"),
        ("online transfer to sav", "2026-10-16", "transfer", "rule"),
    ]
    assert later.merchants == []
    body = client.get("/spending/summary", params=october_range).json()
    # The $60.00 taken out is spending now; the rest stays where it was.
    assert (body["flexible_cents"], body["transfers_ignored_cents"], body["left_over_cents"]) == (
        6_000,
        30_000 + 20_000 + 8_000,
        200_000 - 6_000,
    )
    totals = {c["category"]: (c["bucket"], c["total_cents"]) for c in body["categories"]}
    assert totals["cash"] == ("flexible", 6_000)
    results = no_seed_rules.execute(
        text("SELECT result FROM jobs WHERE kind = 'categorize.run' AND status = 'succeeded'")
    ).scalars()
    assert sorted(r["relabeled"] for r in results) == [0, 1]
