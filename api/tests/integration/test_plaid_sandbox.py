"""A full sync against the live Plaid sandbox (marked ``plaid_sandbox``).

Skipped unless PLAID_CLIENT_ID and PLAID_SECRET (sandbox) are set. Run with
``uv run pytest -m plaid_sandbox api/tests/integration/test_plaid_sandbox.py``.
"""

from __future__ import annotations

import time

import pytest
from pydantic import SecretStr
from sqlalchemy import Connection, text

from app.config import Settings
from app.db import user_session_for
from db.enums import SyncProvider
from jobs.errors import RetryLater
from sync.crypto import cipher_from_settings
from sync.pipeline import SyncItemSecrets, run_sync
from sync.plaid.client import PlaidClient
from sync.plaid.provider import PlaidProvider
from sync.provider import SyncProvider as SyncProviderProtocol
from tests.conftest import FixtureUser
from tests.support.env import TEST_PLAID_TOKEN_KEY, live_credential
from tests.support.factories import make_item

pytestmark = pytest.mark.plaid_sandbox

READY_ATTEMPTS = 12
READY_WAIT_SECONDS = 5.0
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


def test_first_platypus_bank_syncs_end_to_end(
    plaid: PlaidClient, db_connection: Connection, user_a: FixtureUser
) -> None:
    public_token = plaid.sandbox_public_token_create("ins_109508")
    token, provider_item_id = plaid.item_public_token_exchange(public_token)
    try:
        cipher = cipher_from_settings(
            Settings(_env_file=None, plaid_token_key=SecretStr(TEST_PLAID_TOKEN_KEY))
        )
        item = make_item(
            db_connection,
            user_a.id,
            provider_item_id=provider_item_id,
            access_token_enc=cipher.encrypt(token),
        )

        def provider_for(secrets: SyncItemSecrets) -> SyncProviderProtocol:
            assert secrets.provider is SyncProvider.PLAID
            assert secrets.access_token_enc is not None
            return PlaidProvider(plaid, cipher.decrypt(secrets.access_token_enc))

        for _ in range(READY_ATTEMPTS):
            try:
                result = run_sync(
                    user_id=user_a.id,
                    item_id=item,
                    sessions=lambda: user_session_for(user_a.id, bind=db_connection),
                    provider_for=provider_for,
                )
                break
            except RetryLater:
                time.sleep(READY_WAIT_SECONDS)
        else:
            pytest.fail("Plaid never finished preparing the sandbox item")

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
        kinds: dict[str, str] = dict(
            db_connection.execute(
                text("SELECT name, kind::text FROM accounts WHERE user_id = :u"),
                {"u": user_a.id},
            ).all()
        )
        # The sandbox's loans are loans, never credit cards (spec 002 rule 4).
        assert {name: kinds.get(name) for name in SANDBOX_LOANS} == dict.fromkeys(
            SANDBOX_LOANS, "loan"
        )
    finally:
        plaid.item_remove(token)
