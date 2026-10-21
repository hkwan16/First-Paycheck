"""The Plaid fixture recorder, against a fake client (the live path needs sandbox keys)."""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from pydantic import SecretStr

from scripts import record_plaid_fixtures
from sync.plaid.client import PlaidError

ACCESS = "access-sandbox-11111111-2222-3333-4444-555555555555"


def page(
    cursor: str, *, has_more: bool, status: str = "HISTORICAL_UPDATE_COMPLETE"
) -> dict[str, Any]:
    return {
        "added": [{"transaction_id": cursor, "amount": Decimal("4.335"), "item_id": "item-live"}],
        "modified": [],
        "removed": [],
        "next_cursor": cursor,
        "has_more": has_more,
        "transactions_update_status": status,
        "request_id": "req-live",
    }


class FakeClient:
    def __init__(self, sync_pages: list[dict[str, Any] | Exception]) -> None:
        self.sync_pages = sync_pages
        self.calls: list[tuple[str, Any]] = []

    def sandbox_public_token_create(
        self, institution_id: str, *, webhook: str | None = None, username: str | None = None
    ) -> str:
        self.calls.append(("sandbox_public_token_create", (institution_id, username)))
        return "public-sandbox-1"

    def item_public_token_exchange(self, public_token: str) -> tuple[SecretStr, str]:
        self.calls.append(("item_public_token_exchange", public_token))
        return SecretStr(ACCESS), "item-live"

    def transactions_sync(self, access_token: SecretStr, cursor: str | None) -> dict[str, Any]:
        self.calls.append(("transactions_sync", cursor))
        answer = self.sync_pages.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    def accounts_get(self, access_token: SecretStr) -> dict[str, Any]:
        self.calls.append(("accounts_get", None))
        return {
            "accounts": [{"account_id": "a1", "balances": {"current": Decimal("110")}}],
            "item": {"item_id": "item-live", "webhook": ""},
            "request_id": "req-live",
        }

    def investments_holdings_get(self, access_token: SecretStr) -> dict[str, Any]:
        self.calls.append(("investments_holdings_get", None))
        return {"holdings": [], "securities": [], "accounts": [], "request_id": "req-live"}

    def item_remove(self, access_token: SecretStr) -> None:
        self.calls.append(("item_remove", access_token.get_secret_value()))


def record(client: FakeClient, out: Path, products: list[str]) -> list[Path]:
    return record_plaid_fixtures.record(
        client,
        institution="ins_109508",
        username="user_good",
        products=products,
        out=out,
        sleep=lambda _: None,
    )


def test_arguments_have_sandbox_defaults() -> None:
    args = record_plaid_fixtures.parse_args([])
    assert args.institution == "ins_109508"
    assert args.username == "user_good"
    assert args.products == ["transactions"]


def test_products_and_output_are_configurable() -> None:
    args = record_plaid_fixtures.parse_args(
        ["--products", "transactions", "investments", "--out", "/tmp/plaid"]
    )
    assert args.products == ["transactions", "investments"]
    assert str(args.out) == "/tmp/plaid"


def test_records_every_page_scrubbed(tmp_path: Path) -> None:
    client = FakeClient([page("c1", has_more=True), page("c2", has_more=False)])
    written = record(client, tmp_path, ["transactions", "investments"])

    assert sorted(path.name for path in written) == [
        "accounts_get.json",
        "investments_holdings_get.json",
        "transactions_sync_page1.json",
        "transactions_sync_page2.json",
    ]
    text = "\n".join(path.read_text() for path in written)
    assert ACCESS not in text
    assert "item-live" not in text
    assert "req-live" not in text
    page2 = json.loads((tmp_path / "transactions_sync_page2.json").read_text())
    # Money is written back exactly as Plaid sent it.
    assert '"amount": 4.335' in (tmp_path / "transactions_sync_page2.json").read_text()
    assert page2["added"][0]["item_id"] == "item-redacted"
    assert [c for c in client.calls if c[0] == "transactions_sync"] == [
        ("transactions_sync", None),
        ("transactions_sync", "c1"),
    ]
    # The sandbox item is removed afterwards.
    assert client.calls[-1] == ("item_remove", ACCESS)


def test_waits_for_transactions_to_be_ready(tmp_path: Path) -> None:
    not_ready = PlaidError(
        code="PRODUCT_NOT_READY", error_type="ITEM_ERROR", message="wait", request_id=None
    )
    client = FakeClient(
        [not_ready, page("c0", has_more=False, status="NOT_READY"), page("c1", has_more=False)]
    )
    written = record(client, tmp_path, ["transactions"])
    assert [path.name for path in written if "sync" in path.name] == [
        "transactions_sync_page1.json"
    ]
    assert "investments_holdings_get" not in [name for name, _ in client.calls]


def test_the_item_is_removed_even_when_recording_fails(tmp_path: Path) -> None:
    boom = PlaidError(
        code="INTERNAL_SERVER_ERROR", error_type="API_ERROR", message="x", request_id=None
    )
    client = FakeClient([boom])
    with pytest.raises(PlaidError):
        record(client, tmp_path, ["transactions"])
    assert client.calls[-1][0] == "item_remove"


def test_without_credentials_it_explains_and_exits(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PLAID_CLIENT_ID", "")
    monkeypatch.setenv("PLAID_SECRET", "")
    assert record_plaid_fixtures.main([]) == 2
    assert "PLAID_CLIENT_ID" in capsys.readouterr().err


def test_refuses_production(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PLAID_CLIENT_ID", "cid")
    monkeypatch.setenv("PLAID_SECRET", "sekrit")
    monkeypatch.setenv("PLAID_ENV", "production")
    assert record_plaid_fixtures.main([]) == 2
    assert "sandbox" in capsys.readouterr().err
