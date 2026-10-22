"""The Plaid sandbox history a new user links, run through the real pipeline.

The recorded ``/accounts/get`` and ``/transactions/sync`` responses
(``tests/fixtures/plaid/recorded``) go through ``PlaidProvider`` and
``run_sync``, then the seed rules label them with no model, the way a new
user's first sync and categorize jobs do. The sandbox books its GUSTO PAY
payroll as money out (5,850.00, positive) while the seed rules label it
``income``: the shape behind the October 22 walkthrough's negative income.

``DYNAMIC`` (``tests/fixtures/plaid/recorded_dynamic``) is Plaid's
``user_transactions_dynamic`` sandbox user, recorded on 2026-10-22 with
``scripts/record_plaid_fixtures.py --username user_transactions_dynamic``:
weekly payroll into checking, a credit card, and five loan accounts whose own
ledgers book each "Monthly payment" as money in and "Interest charged" as
money out, the shape behind the walkthrough's loan-driven spending summary.
"""

from __future__ import annotations

import datetime as dt
import json
import uuid
from contextlib import AbstractContextManager
from decimal import Decimal
from pathlib import Path
from typing import Any

from pydantic import SecretStr
from sqlalchemy import Connection
from sqlalchemy.orm import Session

from app.db import user_session_for
from sync.categorize import categorize_user
from sync.pipeline import SyncItemSecrets, run_sync
from sync.plaid.provider import PlaidProvider
from sync.provider import SyncProvider
from tests.conftest import FixtureUser
from tests.support.factories import make_item

_PLAID_FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "plaid"
RECORDED = _PLAID_FIXTURES / "recorded"
DYNAMIC = _PLAID_FIXTURES / "recorded_dynamic"
SYNCED_AT = dt.datetime(2026, 10, 22, 15, 0, tzinfo=dt.UTC)


class RecordedPlaidClient:
    """Answers the provider's three calls with one recording's sandbox responses."""

    def __init__(self, recording: Path = RECORDED) -> None:
        self._recording = recording

    def _recorded(self, name: str) -> dict[str, Any]:
        text = (self._recording / f"{name}.json").read_text()
        data: dict[str, Any] = json.loads(text, parse_float=Decimal)
        return data

    def accounts_get(self, access_token: SecretStr) -> dict[str, Any]:
        return self._recorded("accounts_get")

    def transactions_sync(self, access_token: SecretStr, cursor: str | None) -> dict[str, Any]:
        return self._recorded("transactions_sync_page1")

    def investments_holdings_get(self, access_token: SecretStr) -> dict[str, Any]:
        return self._recorded("investments_holdings_get")


def link_sandbox(
    connection: Connection, user: FixtureUser, recording: Path = RECORDED
) -> uuid.UUID:
    """Sync a recorded sandbox item for ``user`` and label it with the seed rules.

    ``recording`` is ``RECORDED`` (``user_good``) or ``DYNAMIC``. Needs the seed
    rules loaded (the ``seeded_rules`` fixture). Returns the item id.
    """
    item_id = make_item(connection, user.id)

    def sessions() -> AbstractContextManager[Session]:
        return user_session_for(user.id, bind=connection)

    def provider_for(secrets: SyncItemSecrets) -> SyncProvider:
        return PlaidProvider(RecordedPlaidClient(recording), SecretStr("access-sandbox-recorded"))

    result = run_sync(
        user_id=user.id,
        item_id=item_id,
        sessions=sessions,
        provider_for=provider_for,
        now=SYNCED_AT,
    )
    assert result.outcome == "synced", result
    categorize_user(user_id=user.id, sessions=sessions, labeler=None)
    return item_id
