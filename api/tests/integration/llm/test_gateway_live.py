"""One real categorize call (marked ``llm_live``; skipped without a key).

Run with ``uv run pytest -m llm_live api/tests/integration/llm``. It costs a
fraction of a cent.
"""

from __future__ import annotations

import datetime as dt

import pytest
from pydantic import SecretStr
from sqlalchemy import Connection, text

from app.config import Settings
from ingest.pipeline import prepare_document
from llm.gateway import CategorizeItem, LLMGateway
from tests.conftest import FixtureUser
from tests.support.documents import ACME_STUB_LINES, text_pdf
from tests.support.env import live_credential

pytestmark = pytest.mark.llm_live


def test_live_categorize(db_connection: Connection, user_a: FixtureUser) -> None:
    key = live_credential("ANTHROPIC_API_KEY")
    if key is None:
        pytest.skip("ANTHROPIC_API_KEY is not set")
    settings = Settings(_env_file=None, anthropic_api_key=SecretStr(key), llm_fake=False)
    items = [
        CategorizeItem(id=1, merchant="netflix.com", amount_cents=1599, date=dt.date(2026, 10, 5)),
        CategorizeItem(id=2, merchant="shell oil", amount_cents=4210, date=dt.date(2026, 10, 6)),
    ]
    batch = LLMGateway(settings, bind=db_connection).categorize(user_a.id, items)

    labels = {item.id: item.category for item in batch.items}
    assert labels.get(1) in {"subscriptions", "entertainment"}
    assert labels.get(2) == "transport"
    status, cost = db_connection.execute(
        text("SELECT status, cost_microcents FROM llm_calls WHERE user_id = :u"), {"u": user_a.id}
    ).one()
    assert status == "ok"
    assert cost > 0


def test_live_extract_pay_stub(db_connection: Connection, user_a: FixtureUser) -> None:
    """One real Sonnet extraction of a redacted text-layer stub (about one cent)."""
    key = live_credential("ANTHROPIC_API_KEY")
    if key is None:
        pytest.skip("ANTHROPIC_API_KEY is not set")
    settings = Settings(_env_file=None, anthropic_api_key=SecretStr(key), llm_fake=False)
    prepared = prepare_document(text_pdf([ACME_STUB_LINES]), "application/pdf")
    stub = LLMGateway(settings, bind=db_connection).extract_pay_stub(
        user_a.id, prepared.model_pages
    )
    assert stub.gross_cents.value == 270_833
    assert stub.net_cents.value == 199_604
    assert stub.pay_date.value == dt.date(2026, 10, 15)
