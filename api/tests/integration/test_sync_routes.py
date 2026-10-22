"""/sync routes: linking, unlinking, manual syncs and the Plaid webhook (spec 002)."""

from __future__ import annotations

import json
import logging
import time
import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import Connection, column, func, select, table, text

from app.config import Settings
from app.deps import get_db_bind, get_plaid_client, sandbox_linking_allowed
from sync.crypto import cipher_from_settings
from sync.plaid.client import PlaidError
from tests.conftest import FixtureUser
from tests.support.env import TEST_PLAID_TOKEN_KEY
from tests.support.factories import make_account, make_csv_item, make_item, make_transaction
from tests.support.fake_plaid import FakePlaidClient, plaid_error, sign_webhook

Client = Callable[[FixtureUser], TestClient]


@pytest.fixture
def empty_queue(db_connection: Connection) -> Connection:
    db_connection.execute(text("DELETE FROM jobs"))
    return db_connection


def jobs(connection: Connection) -> list[dict[str, Any]]:
    rows = connection.execute(
        text(
            "SELECT id, user_id, kind::text, payload, idempotency_key FROM jobs"
            " WHERE kind <> 'schedule.tick' ORDER BY created_at, id"
        )
    )
    return [dict(row._mapping) for row in rows]


def cipher() -> Any:
    return cipher_from_settings(
        Settings(_env_file=None, plaid_token_key=SecretStr(TEST_PLAID_TOKEN_KEY))
    )


# Link token -----------------------------------------------------------------------


def test_link_token(client_as: Client, user_a: FixtureUser, fake_plaid: FakePlaidClient) -> None:
    response = client_as(user_a).post("/sync/link-token")
    assert response.status_code == 200
    assert response.json() == {
        "link_token": f"link-sandbox-{user_a.id}",
        "expiration": "2026-10-21T20:00:00Z",
    }
    assert fake_plaid.calls == [("link_token_create", {"user_id": str(user_a.id), "webhook": None})]


def test_link_token_needs_auth(app: FastAPI) -> None:
    assert TestClient(app).post("/sync/link-token").status_code == 401


def test_plaid_outage_is_503(
    client_as: Client, user_a: FixtureUser, fake_plaid: FakePlaidClient
) -> None:
    fake_plaid.fail["link_token_create"] = PlaidError(
        code="NETWORK_ERROR", error_type="NETWORK_ERROR", message="down", request_id=None
    )
    response = client_as(user_a).post("/sync/link-token")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "plaid_unavailable"


def test_unconfigured_plaid_is_503(app: FastAPI, client_as: Client, user_a: FixtureUser) -> None:
    # Tests blank PLAID_CLIENT_ID, so the real dependency reports it.
    del app.dependency_overrides[get_plaid_client]
    response = client_as(user_a).post("/sync/link-token")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "plaid_unavailable"


# Linking an item ----------------------------------------------------------------


def test_link_item_with_a_public_token(
    empty_queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    response = client_as(user_a).post(
        "/sync/items", json={"public_token": "public-sandbox-abc", "institution_name": "Platypus"}
    )
    assert response.status_code == 201, response.text
    body = response.json()
    item = body["item"]
    assert item["institution_name"] == "Platypus"
    assert item["status"] == "active"
    assert item["last_synced_at"] is None
    assert "access-sandbox-abc" not in response.text
    assert "access_token" not in item

    row = empty_queue.execute(
        text("SELECT user_id, provider_item_id, access_token_enc FROM sync_items WHERE id = :id"),
        {"id": item["id"]},
    ).one()
    assert (row.user_id, row.provider_item_id) == (user_a.id, "item-abc")
    assert b"access-sandbox-abc" not in bytes(row.access_token_enc)
    assert cipher().decrypt(bytes(row.access_token_enc)).get_secret_value() == "access-sandbox-abc"

    [job] = jobs(empty_queue)
    assert str(job["id"]) == body["job_id"]
    assert (job["user_id"], job["kind"], job["payload"], job["idempotency_key"]) == (
        user_a.id,
        "sync.initial",
        {"sync_item_id": item["id"]},
        f"sync.initial:{item['id']}",
    )


def test_link_a_sandbox_institution(
    db_connection: Connection, client_as: Client, user_a: FixtureUser, fake_plaid: FakePlaidClient
) -> None:
    response = client_as(user_a).post("/sync/items", json={"sandbox_institution_id": "ins_109508"})
    assert response.status_code == 201, response.text
    assert response.json()["item"]["institution_name"] == "First Platypus Bank"
    assert [name for name, _ in fake_plaid.calls] == [
        "sandbox_public_token_create",
        "item_public_token_exchange",
        "institution_name",
    ]
    # No sandbox user named: Plaid links its default, user_good (spec 002 rule 27).
    assert fake_plaid.calls[0][1] == {
        "institution_id": "ins_109508",
        "webhook": None,
        "username": None,
        "password": None,
    }


# A user_custom configuration: a Plaid test fixture, but handled like a secret.
CUSTOM_CONFIG = json.dumps(
    {
        "override_accounts": [
            {
                "type": "depository",
                "subtype": "checking",
                "starting_balance": 100,
                "meta": {"name": "Distinctive Custom Checking"},
                "transactions": [],
            }
        ]
    }
)


def test_link_a_named_sandbox_user(
    client_as: Client,
    user_a: FixtureUser,
    fake_plaid: FakePlaidClient,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Spec 002 rule 27: the sandbox user and its password reach Plaid as the
    override options, and the password is never echoed or logged."""
    with caplog.at_level(logging.DEBUG):
        response = client_as(user_a).post(
            "/sync/items",
            json={
                "sandbox_institution_id": "ins_109508",
                "sandbox_username": "user_custom",
                "sandbox_password": CUSTOM_CONFIG,
            },
        )
    assert response.status_code == 201, response.text
    sent = fake_plaid.calls[0][1]
    assert (sent["institution_id"], sent["username"]) == ("ins_109508", "user_custom")
    assert isinstance(sent["password"], SecretStr)
    assert sent["password"].get_secret_value() == CUSTOM_CONFIG
    assert "Distinctive" not in response.text
    assert "Distinctive" not in caplog.text


def test_a_sandbox_user_without_a_password(
    client_as: Client, user_a: FixtureUser, fake_plaid: FakePlaidClient
) -> None:
    response = client_as(user_a).post(
        "/sync/items",
        json={
            "sandbox_institution_id": "ins_109508",
            "sandbox_username": "user_transactions_dynamic",
        },
    )
    assert response.status_code == 201, response.text
    sent = fake_plaid.calls[0][1]
    assert (sent["username"], sent["password"]) == ("user_transactions_dynamic", None)


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"public_token": "public-sandbox-1", "sandbox_institution_id": "ins_109508"},
        {"public_token": ""},
        {"public_token": "x" * 513},
        {"public_token": "public-sandbox-1", "institution_name": ""},
        # A sandbox user only with a sandbox institution (spec 002 rule 27).
        {"public_token": "public-sandbox-1", "sandbox_username": "user_good"},
        {"public_token": "public-sandbox-1", "sandbox_username": "u", "sandbox_password": "p"},
        {"public_token": "public-sandbox-1", "sandbox_password": "p"},
        {"sandbox_institution_id": "ins_109508", "sandbox_password": "p"},
        {"sandbox_institution_id": "ins_109508", "sandbox_username": ""},
        {"sandbox_institution_id": "ins_109508", "sandbox_username": "u" * 65},
        {"sandbox_institution_id": "ins_109508", "sandbox_username": "u", "sandbox_password": ""},
        {
            "sandbox_institution_id": "ins_109508",
            "sandbox_username": "user_custom",
            "sandbox_password": "x" * 65_537,
        },
    ],
)
def test_link_item_validation(
    client_as: Client, user_a: FixtureUser, fake_plaid: FakePlaidClient, body: dict[str, Any]
) -> None:
    response = client_as(user_a).post("/sync/items", json=body)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
    assert fake_plaid.calls == []


def test_the_longest_sandbox_user_is_accepted(
    client_as: Client, user_a: FixtureUser, fake_plaid: FakePlaidClient
) -> None:
    password = "x" * 65_536
    response = client_as(user_a).post(
        "/sync/items",
        json={
            "sandbox_institution_id": "ins_109508",
            "sandbox_username": "u" * 64,
            "sandbox_password": password,
        },
    )
    assert response.status_code == 201, response.text
    assert fake_plaid.calls[0][1]["password"].get_secret_value() == password


@pytest.mark.parametrize(
    "body",
    [
        {"public_token": "public-sandbox-1", "sandbox_username": "u"},
        {"sandbox_institution_id": "ins_109508"},
        {"sandbox_institution_id": "ins_109508", "sandbox_username": "u" * 65},
    ],
)
def test_a_rejected_password_is_never_echoed(
    client_as: Client, user_a: FixtureUser, body: dict[str, Any]
) -> None:
    """Spec 002 edge cases: a 422 names the field and the rule, never the value."""
    response = client_as(user_a).post(
        "/sync/items", json={**body, "sandbox_password": "Distinctive-config"}
    )
    assert response.status_code == 422
    assert "Distinctive" not in response.text


def test_a_custom_user_plaid_cannot_read_is_502_without_the_password(
    client_as: Client,
    user_a: FixtureUser,
    fake_plaid: FakePlaidClient,
    caplog: pytest.LogCaptureFixture,
) -> None:
    fake_plaid.fail["sandbox_public_token_create"] = plaid_error(
        "INVALID_CREDENTIALS", error_type="ITEM_ERROR"
    )
    with caplog.at_level(logging.DEBUG):
        response = client_as(user_a).post(
            "/sync/items",
            json={
                "sandbox_institution_id": "ins_109508",
                "sandbox_username": "user_custom",
                "sandbox_password": CUSTOM_CONFIG,
            },
        )
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "plaid_error"
    assert "Distinctive" not in response.text
    assert "Distinctive" not in caplog.text


def test_sandbox_linking_is_refused_in_production(
    app: FastAPI, client_as: Client, user_a: FixtureUser, fake_plaid: FakePlaidClient
) -> None:
    app.dependency_overrides[sandbox_linking_allowed] = lambda: False
    response = client_as(user_a).post("/sync/items", json={"sandbox_institution_id": "ins_109508"})
    assert response.status_code == 422
    assert fake_plaid.calls == []


def test_sandbox_linking_allowed_follows_the_plaid_environment() -> None:
    """Spec 002 rule 27: the shortcut exists only in Plaid's sandbox, so the
    Plaid environment decides, not APP_ENV. The deployed stack stays walkable
    until Plaid production is approved and closes by itself after."""
    sandbox_in_production = Settings.model_construct(app_env="production", plaid_env="sandbox")
    assert sandbox_linking_allowed(sandbox_in_production) is True
    live_plaid_in_development = Settings(
        _env_file=None, app_env="development", plaid_env="production"
    )
    assert sandbox_linking_allowed(live_plaid_in_development) is False


def test_an_item_cannot_be_linked_twice(
    client_as: Client, user_a: FixtureUser, user_b: FixtureUser
) -> None:
    first = client_as(user_a).post("/sync/items", json={"public_token": "public-sandbox-dup"})
    assert first.status_code == 201
    again = client_as(user_b).post("/sync/items", json={"public_token": "public-sandbox-dup"})
    assert again.status_code == 409
    assert again.json()["error"]["code"] == "item_already_linked"


def test_plaid_rejections_are_502(
    client_as: Client, user_a: FixtureUser, fake_plaid: FakePlaidClient
) -> None:
    fake_plaid.fail["item_public_token_exchange"] = plaid_error("INVALID_PUBLIC_TOKEN")
    response = client_as(user_a).post("/sync/items", json={"public_token": "public-sandbox-x"})
    assert response.status_code == 502
    assert response.json()["error"] == {
        "code": "plaid_error",
        "message": "Plaid rejected the request (INVALID_PUBLIC_TOKEN)",
    }


# Unlinking and manual syncs -------------------------------------------------------


def linked_item(connection: Connection, user: FixtureUser) -> uuid.UUID:
    return make_item(connection, user.id, access_token_enc=cipher().encrypt(SecretStr("access-a")))


def test_delete_item_cascades_and_removes_it_at_plaid(
    db_connection: Connection, client_as: Client, user_a: FixtureUser, fake_plaid: FakePlaidClient
) -> None:
    item = linked_item(db_connection, user_a)
    account = make_account(db_connection, user_a.id, item)
    make_transaction(db_connection, user_a.id, account)

    response = client_as(user_a).delete(f"/sync/items/{item}")

    assert response.status_code == 200
    assert set(response.json()) == {"recurring_job_id"}
    assert fake_plaid.removed == ["access-a"]
    for name in ("sync_items", "accounts", "transactions"):
        rows = table(name, column("user_id"))
        count = db_connection.execute(
            select(func.count()).select_from(rows).where(rows.c.user_id == user_a.id)
        ).scalar_one()
        assert count == 0, name


def test_delete_succeeds_when_plaid_fails(
    db_connection: Connection, client_as: Client, user_a: FixtureUser, fake_plaid: FakePlaidClient
) -> None:
    item = linked_item(db_connection, user_a)
    fake_plaid.fail["item_remove"] = plaid_error("INTERNAL_SERVER_ERROR", "API_ERROR", 500)
    assert client_as(user_a).delete(f"/sync/items/{item}").status_code == 200


def test_delete_unknown_item_is_404(client_as: Client, user_a: FixtureUser) -> None:
    response = client_as(user_a).delete(f"/sync/items/{uuid.uuid4()}")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_manual_sync_reuses_the_queued_job(
    empty_queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    item = linked_item(empty_queue, user_a)
    first = client_as(user_a).post(f"/sync/items/{item}/sync")
    second = client_as(user_a).post(f"/sync/items/{item}/sync")
    assert first.status_code == 202
    assert first.json() == second.json()
    [job] = jobs(empty_queue)
    assert (job["kind"], job["payload"]) == ("sync.incremental", {"sync_item_id": str(item)})


def test_manual_sync_of_a_csv_item_is_refused(
    empty_queue: Connection, client_as: Client, user_a: FixtureUser
) -> None:
    """Spec 002 rule 29: a CSV item has no provider, so a queued sync could only fail."""
    item = make_csv_item(empty_queue, user_a.id)

    response = client_as(user_a).post(f"/sync/items/{item}/sync")

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "not_plaid_item"
    assert jobs(empty_queue) == []


def test_manual_sync_of_unknown_item_is_404(client_as: Client, user_a: FixtureUser) -> None:
    assert client_as(user_a).post(f"/sync/items/{uuid.uuid4()}/sync").status_code == 404


# Webhook --------------------------------------------------------------------------


def webhook_body(
    item_id: str, code: str = "SYNC_UPDATES_AVAILABLE", kind: str = "TRANSACTIONS"
) -> bytes:
    return json.dumps({"webhook_type": kind, "webhook_code": code, "item_id": item_id}).encode()


def post_webhook(app: FastAPI, body: bytes, header: str | None) -> Any:
    headers = {"Content-Type": "application/json"}
    if header is not None:
        headers["Plaid-Verification"] = header
    return TestClient(app).post("/sync/webhook", content=body, headers=headers)


def test_a_verified_webhook_queues_a_sync(
    empty_queue: Connection, app: FastAPI, user_a: FixtureUser
) -> None:
    item = make_item(empty_queue, user_a.id, provider_item_id="plaid-item-a")
    body = webhook_body("plaid-item-a")
    response = post_webhook(app, body, sign_webhook(body))
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert [(j["user_id"], j["kind"], j["payload"]) for j in jobs(empty_queue)] == [
        (user_a.id, "sync.incremental", {"sync_item_id": str(item)})
    ]


@pytest.mark.parametrize(
    ("kind", "code"),
    [
        ("TRANSACTIONS", "DEFAULT_UPDATE"),
        ("TRANSACTIONS", "INITIAL_UPDATE"),
        ("TRANSACTIONS", "HISTORICAL_UPDATE"),
        ("HOLDINGS", "DEFAULT_UPDATE"),
        ("INVESTMENTS_TRANSACTIONS", "DEFAULT_UPDATE"),
    ],
)
def test_update_webhooks_queue_a_sync(
    empty_queue: Connection, app: FastAPI, user_a: FixtureUser, kind: str, code: str
) -> None:
    make_item(empty_queue, user_a.id, provider_item_id="plaid-item-a")
    body = webhook_body("plaid-item-a", code=code, kind=kind)
    assert post_webhook(app, body, sign_webhook(body)).status_code == 200
    assert len(jobs(empty_queue)) == 1


def test_other_webhooks_are_acknowledged_and_ignored(
    empty_queue: Connection, app: FastAPI, user_a: FixtureUser
) -> None:
    make_item(empty_queue, user_a.id, provider_item_id="plaid-item-a")
    body = webhook_body("plaid-item-a", code="PENDING_EXPIRATION", kind="ITEM")
    assert post_webhook(app, body, sign_webhook(body)).status_code == 200
    assert jobs(empty_queue) == []


def test_webhook_unknown_item_is_200(empty_queue: Connection, app: FastAPI) -> None:
    body = webhook_body("plaid-item-nobody")
    response = post_webhook(app, body, sign_webhook(body))
    assert response.status_code == 200
    assert jobs(empty_queue) == []


def test_tampered_webhook_is_401(
    empty_queue: Connection, app: FastAPI, user_a: FixtureUser
) -> None:
    make_item(empty_queue, user_a.id, provider_item_id="plaid-item-a")
    header = sign_webhook(webhook_body("plaid-item-other"))
    response = post_webhook(app, webhook_body("plaid-item-a"), header)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "invalid_webhook"
    assert jobs(empty_queue) == []


@pytest.mark.parametrize(
    "header",
    [None, "garbage", sign_webhook(b"{}", iat=time.time() - 600), sign_webhook(b"{}", kid="nope")],
)
def test_unverifiable_webhooks_are_401(app: FastAPI, header: str | None) -> None:
    assert post_webhook(app, b"{}", header).status_code == 401


def test_a_signed_body_that_is_not_json_is_401(app: FastAPI) -> None:
    body = b"not json"
    assert post_webhook(app, body, sign_webhook(body)).status_code == 401


def test_webhook_keys_are_cached(app: FastAPI, fake_plaid: FakePlaidClient) -> None:
    for _ in range(3):
        body = webhook_body("plaid-item-x")
        post_webhook(app, body, sign_webhook(body))
    assert [name for name, _ in fake_plaid.calls] == ["webhook_verification_key_get"]


def test_unverified_webhooks_never_touch_the_database(app: FastAPI) -> None:
    def no_database() -> None:
        raise AssertionError("the database was used before the signature was checked")

    app.dependency_overrides[get_db_bind] = no_database
    assert post_webhook(app, b"{}", "garbage").status_code == 401
