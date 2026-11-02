"""Full syncs against the live Plaid sandbox (marked ``plaid_sandbox``).

Skipped unless PLAID_CLIENT_ID and PLAID_SECRET (sandbox) are set. Run with
``uv run pytest -m plaid_sandbox api/tests/integration/test_plaid_sandbox.py``
(add ``-o log_cli=true --log-cli-level=INFO`` to see what each sandbox user
returned).
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import time
import uuid
from collections.abc import Callable
from typing import Any

import pytest
from pydantic import SecretStr
from sqlalchemy import Connection, text

from app.config import Settings
from app.db import user_session_for
from db.enums import SyncProvider
from jobs.errors import RetryLater
from sync.crypto import cipher_from_settings
from sync.pipeline import SyncItemSecrets, SyncResult, run_sync
from sync.plaid.client import PlaidClient
from sync.plaid.provider import PlaidProvider
from sync.provider import SyncProvider as SyncProviderProtocol
from tests.conftest import FixtureUser
from tests.support.env import TEST_PLAID_TOKEN_KEY, live_credential
from tests.support.factories import make_item

pytestmark = pytest.mark.plaid_sandbox

logger = logging.getLogger(__name__)

# A sync every second lands in the seconds when Plaid says its pull is done
# but has no rows or cursor yet (spec 002 rule 9a, issue #213).
READY_ATTEMPTS = 60
READY_WAIT_SECONDS = 1.0
SANDBOX_LOANS = (
    "Plaid Student Loan",
    "Plaid Mortgage",
    "Plaid Auto Loan",
    "Plaid Home Equity Line of Credit",
)


@pytest.fixture
def plaid() -> PlaidClient:
    client_id = live_credential("PLAID_CLIENT_ID")
    secret = live_credential("PLAID_SECRET")
    if client_id is None or secret is None:
        pytest.skip("PLAID_CLIENT_ID and PLAID_SECRET are not set")
    settings = Settings(
        _env_file=None,
        plaid_client_id=client_id,
        plaid_secret=SecretStr(secret),
        plaid_env="sandbox",
    )
    return PlaidClient.from_settings(settings)


Sync = Callable[[dt.datetime | None], SyncResult]


def store_linked_item(
    plaid: PlaidClient,
    db_connection: Connection,
    user: FixtureUser,
    token: SecretStr,
    provider_item_id: str,
) -> tuple[uuid.UUID, Sync]:
    """Store the item for ``user``; the callable runs one sync of it at ``now``."""
    cipher = cipher_from_settings(
        Settings(_env_file=None, plaid_token_key=SecretStr(TEST_PLAID_TOKEN_KEY))
    )
    item = make_item(
        db_connection,
        user.id,
        provider_item_id=provider_item_id,
        access_token_enc=cipher.encrypt(token),
    )

    def provider_for(secrets: SyncItemSecrets) -> SyncProviderProtocol:
        assert secrets.provider is SyncProvider.PLAID
        assert secrets.access_token_enc is not None
        return PlaidProvider(plaid, cipher.decrypt(secrets.access_token_enc))

    def sync(now: dt.datetime | None) -> SyncResult:
        return run_sync(
            user_id=user.id,
            item_id=item,
            sessions=lambda: user_session_for(user.id, bind=db_connection),
            provider_for=provider_for,
            now=now,
        )

    return item, sync


def sync_linked_item(
    plaid: PlaidClient,
    db_connection: Connection,
    user: FixtureUser,
    token: SecretStr,
    provider_item_id: str,
) -> tuple[uuid.UUID, SyncResult]:
    """Store the item for ``user`` and run its first sync, waiting for Plaid."""
    item, sync = store_linked_item(plaid, db_connection, user, token, provider_item_id)
    for _ in range(READY_ATTEMPTS):
        try:
            return item, sync(None)
        except RetryLater:
            time.sleep(READY_WAIT_SECONDS)
    pytest.fail("Plaid never finished preparing the sandbox item")


def item_state(db_connection: Connection, user: FixtureUser, item: uuid.UUID) -> tuple[Any, ...]:
    """The user's transaction count, then the item's cursor and link time."""
    return tuple(
        db_connection.execute(
            text(
                "SELECT (SELECT count(*) FROM transactions WHERE user_id = :u),"
                " cursor, created_at FROM sync_items WHERE id = :item"
            ),
            {"u": user.id, "item": item},
        ).one()
    )


def account_kinds(db_connection: Connection, user: FixtureUser) -> dict[str, str]:
    return dict(
        db_connection.execute(
            text("SELECT name, kind::text FROM accounts WHERE user_id = :u"), {"u": user.id}
        ).all()
    )


def test_first_platypus_bank_syncs_end_to_end(
    plaid: PlaidClient, db_connection: Connection, user_a: FixtureUser
) -> None:
    public_token = plaid.sandbox_public_token_create("ins_109508")
    token, provider_item_id = plaid.item_public_token_exchange(public_token)
    try:
        item, result = sync_linked_item(plaid, db_connection, user_a, token, provider_item_id)

        assert result.outcome == "synced"
        assert result.accounts >= 1
        assert result.added >= 1
        counts = db_connection.execute(
            text(
                "SELECT (SELECT count(*) FROM accounts WHERE user_id = :u),"
                " (SELECT count(*) FROM transactions WHERE user_id = :u),"
                " (SELECT count(*) FROM balance_snapshots WHERE user_id = :u),"
                " (SELECT cursor FROM sync_items WHERE id = :item)"
            ),
            {"u": user_a.id, "item": item},
        ).one()
        assert counts[0] >= 1
        assert counts[1] >= 1
        assert counts[2] >= 1
        assert counts[3]
        kinds = account_kinds(db_connection, user_a)
        # The sandbox's loans are loans, never credit cards (spec 002 rule 4).
        assert {name: kinds.get(name) for name in SANDBOX_LOANS} == dict.fromkeys(
            SANDBOX_LOANS, "loan"
        )
    finally:
        plaid.item_remove(token)


def test_a_named_sandbox_user_links_its_own_data(
    plaid: PlaidClient, db_connection: Connection, user_a: FixtureUser
) -> None:
    """Spec 002 rule 27: ``user_transactions_dynamic`` has a checking account,
    a credit card and a loan with a history dated relative to today."""
    public_token = plaid.sandbox_public_token_create(
        "ins_109508", username="user_transactions_dynamic"
    )
    token, provider_item_id = plaid.item_public_token_exchange(public_token)
    try:
        _, result = sync_linked_item(plaid, db_connection, user_a, token, provider_item_id)

        assert result.outcome == "synced"
        assert result.added >= 1
        kinds = account_kinds(db_connection, user_a)
        transactions = db_connection.execute(
            text("SELECT count(*) FROM transactions WHERE user_id = :u"), {"u": user_a.id}
        ).scalar_one()
        logger.info("user_transactions_dynamic: accounts %s, %d transactions", kinds, transactions)
        assert {"loan", "credit"} & set(kinds.values()), kinds
        assert transactions >= 1
    finally:
        plaid.item_remove(token)


def test_a_just_linked_item_never_syncs_empty(
    plaid: PlaidClient, db_connection: Connection, user_a: FixtureUser
) -> None:
    """Spec 002 example 14 (issue #213): ``user_good`` has transactions, so its
    first sync waits for them or brings them, and never succeeds with none."""
    public_token = plaid.sandbox_public_token_create("ins_109508")
    token, provider_item_id = plaid.item_public_token_exchange(public_token)
    try:
        item, result = sync_linked_item(plaid, db_connection, user_a, token, provider_item_id)

        transactions, cursor, _ = item_state(db_connection, user_a, item)
        assert (result.outcome, result.added > 0, transactions > 0) == ("synced", True, True)
        assert cursor
    finally:
        plaid.item_remove(token)


# A user_custom configuration: one checking account with no transactions.
EMPTY_ACCOUNT = json.dumps(
    {
        "override_accounts": [
            {
                "type": "depository",
                "subtype": "checking",
                "starting_balance": 100,
                "meta": {"name": "Empty Checking"},
                "transactions": [],
            }
        ]
    }
)


def test_an_item_with_no_transactions_syncs_its_accounts(
    plaid: PlaidClient, db_connection: Connection, user_a: FixtureUser
) -> None:
    """Spec 002 rule 11a: Plaid never sends a cursor for an item with no
    transactions, so its sync waits while the item is new, then goes on."""
    public_token = plaid.sandbox_public_token_create(
        "ins_109508", username="user_custom", password=SecretStr(EMPTY_ACCOUNT)
    )
    token, provider_item_id = plaid.item_public_token_exchange(public_token)
    try:
        item, sync = store_linked_item(plaid, db_connection, user_a, token, provider_item_id)
        # Well past the seconds a sandbox item with rows takes to get them.
        time.sleep(15)
        with pytest.raises(RetryLater):
            sync(None)

        _, _, linked_at = item_state(db_connection, user_a, item)
        result = sync(linked_at + dt.timedelta(minutes=5))

        assert (result.outcome, result.accounts, result.added) == ("synced", 1, 0)
        assert item_state(db_connection, user_a, item)[:2] == (0, None)
        assert account_kinds(db_connection, user_a) == {"Empty Checking": "checking"}
    finally:
        plaid.item_remove(token)
