"""PlaidClient over the real plaid-python stack, with only urllib3's pool faked."""

from __future__ import annotations

import json
from decimal import Decimal
from typing import Any

import pytest
import urllib3
from pydantic import SecretStr

from app.config import Settings
from sync.plaid.client import PlaidClient, PlaidError, PlaidNotConfigured

ACCESS = SecretStr("access-sandbox-de305d54-75b4-431b-adb2-eb6b9e546014")


class FakePool:
    """Records requests and answers with canned (status, body) pairs."""

    def __init__(self, *answers: tuple[int, dict[str, Any]] | Exception) -> None:
        self.answers = list(answers)
        self.requests: list[tuple[str, dict[str, Any]]] = []
        self.headers: list[dict[str, str]] = []

    def request(self, method: str, url: str, **kwargs: Any) -> urllib3.HTTPResponse:
        path = "/".join(url.split("/")[-2:])
        self.requests.append((path, json.loads(kwargs["body"])))
        self.headers.append(kwargs["headers"])
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        status, body = answer
        return urllib3.HTTPResponse(
            body=json.dumps(body).encode(),
            status=status,
            headers={"Content-Type": "application/json"},
            preload_content=False,
        )


def client(*answers: tuple[int, dict[str, Any]] | Exception) -> tuple[PlaidClient, FakePool]:
    settings = Settings(_env_file=None, plaid_client_id="cid", plaid_secret=SecretStr("sekrit"))
    plaid = PlaidClient.from_settings(settings)
    pool = FakePool(*answers)
    plaid.api.api_client.rest_client.pool_manager = pool
    return plaid, pool


def test_requests_carry_credentials_and_parse_money_as_decimal() -> None:
    plaid, pool = client((200, {"accounts": [{"balances": {"current": 4.335}}], "request_id": "r"}))
    body = plaid.accounts_get(ACCESS)
    path, sent = pool.requests[0]
    headers = pool.headers[0]
    assert path == "accounts/get"
    assert sent["access_token"] == ACCESS.get_secret_value()
    assert (headers["PLAID-CLIENT-ID"], headers["PLAID-SECRET"]) == ("cid", "sekrit")
    assert headers["Plaid-Version"] == "2020-09-14"
    assert body["accounts"][0]["balances"]["current"] == Decimal("4.335")


def test_transactions_sync_sends_the_cursor_only_when_there_is_one() -> None:
    page = {"added": [], "modified": [], "removed": [], "next_cursor": "c1", "has_more": False}
    plaid, pool = client((200, page), (200, page))
    plaid.transactions_sync(ACCESS, None)
    plaid.transactions_sync(ACCESS, "c1")
    assert "cursor" not in pool.requests[0][1]
    assert pool.requests[1][1]["cursor"] == "c1"
    assert pool.requests[1][1]["count"] == 500


def test_link_token_names_the_user_products_and_webhook() -> None:
    link = {"link_token": "link-sandbox-1", "expiration": "2026-10-21T20:00:00Z"}
    plaid, pool = client((200, link))
    token = plaid.link_token_create(user_id="u-1", webhook="https://api.example/sync/webhook")
    sent = pool.requests[0][1]
    assert token == {"link_token": "link-sandbox-1", "expiration": "2026-10-21T20:00:00Z"}
    assert sent["user"] == {"client_user_id": "u-1"}
    assert sent["products"] == ["transactions"]
    assert sent["optional_products"] == ["investments"]
    assert sent["webhook"] == "https://api.example/sync/webhook"
    assert sent["country_codes"] == ["US"]


def test_exchange_returns_a_secret_token() -> None:
    plaid, _ = client((200, {"access_token": ACCESS.get_secret_value(), "item_id": "item-1"}))
    token, item_id = plaid.item_public_token_exchange("public-sandbox-1")
    assert isinstance(token, SecretStr)
    assert token.get_secret_value() == ACCESS.get_secret_value()
    assert item_id == "item-1"


def test_sandbox_public_token_and_institution_name() -> None:
    plaid, pool = client(
        (200, {"public_token": "public-sandbox-2"}),
        (200, {"institution": {"name": "First Platypus Bank"}}),
    )
    assert plaid.sandbox_public_token_create("ins_109508") == "public-sandbox-2"
    assert pool.requests[0][1]["initial_products"] == ["transactions", "investments"]
    assert plaid.institution_name("ins_109508") == "First Platypus Bank"


def test_errors_become_plaid_errors_without_secrets() -> None:
    plaid, _ = client(
        (
            400,
            {
                "error_type": "ITEM_ERROR",
                "error_code": "ITEM_LOGIN_REQUIRED",
                "error_message": "the login details of this item have changed",
                "display_message": None,
                "request_id": "req-9",
            },
        )
    )
    with pytest.raises(PlaidError) as failure:
        plaid.accounts_get(ACCESS)
    error = failure.value
    assert (error.code, error.error_type, error.request_id, error.status) == (
        "ITEM_LOGIN_REQUIRED",
        "ITEM_ERROR",
        "req-9",
        400,
    )
    assert ACCESS.get_secret_value() not in str(error)
    assert "sekrit" not in str(error)
    assert error.__cause__ is None


def test_server_errors_and_garbage_bodies_are_plaid_errors() -> None:
    plaid, _ = client((500, {"unexpected": True}))
    with pytest.raises(PlaidError) as failure:
        plaid.item_remove(ACCESS)
    assert (failure.value.code, failure.value.status) == ("UNKNOWN", 500)


def test_network_failures_are_plaid_errors() -> None:
    plaid, _ = client(urllib3.exceptions.MaxRetryError(None, "/accounts/get", "refused"))  # type: ignore[arg-type]
    with pytest.raises(PlaidError) as failure:
        plaid.accounts_get(ACCESS)
    assert failure.value.code == "NETWORK_ERROR"


def test_webhook_key_lookup() -> None:
    key = {"alg": "ES256", "kid": "k1", "kty": "EC", "crv": "P-256", "x": "x", "y": "y"}
    plaid, pool = client((200, {"key": key, "request_id": "r"}))
    assert plaid.webhook_verification_key_get("k1") == key
    assert pool.requests[0][1]["key_id"] == "k1"


def test_missing_credentials_are_a_configuration_error() -> None:
    with pytest.raises(PlaidNotConfigured, match="PLAID_CLIENT_ID"):
        PlaidClient.from_settings(Settings(_env_file=None))
