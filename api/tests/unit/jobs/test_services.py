"""The worker's real collaborators, built from settings."""

from __future__ import annotations

import logging
import uuid
from typing import Any

import pytest
from pydantic import SecretStr

from app.config import Settings
from db.enums import SyncProvider
from jobs.services import default_services
from llm.gateway import FakeGateway, LLMGateway
from sync.crypto import cipher_from_settings
from sync.pipeline import SyncItemSecrets
from sync.plaid.client import PlaidNotConfigured
from sync.plaid.provider import PlaidProvider
from tests.support.env import TEST_PLAID_TOKEN_KEY

TOKEN = SecretStr("access-sandbox-0000")


def settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "plaid_client_id": "cid",
        "plaid_secret": SecretStr("sekrit"),
        "plaid_token_key": SecretStr(TEST_PLAID_TOKEN_KEY),
        "llm_fake": True,
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)


def secrets(config: Settings, *, provider: SyncProvider = SyncProvider.PLAID) -> SyncItemSecrets:
    return SyncItemSecrets(
        id=uuid.uuid4(),
        provider=provider,
        provider_item_id="item-1",
        access_token_enc=cipher_from_settings(config).encrypt(TOKEN),
    )


def test_plaid_items_get_a_plaid_provider() -> None:
    config = settings()
    services = default_services(config)
    assert services.provider_for is not None
    provider = services.provider_for(secrets(config))
    assert isinstance(provider, PlaidProvider)
    assert TOKEN.get_secret_value() not in repr(provider)


def test_missing_plaid_credentials_fail_the_sync_not_the_worker() -> None:
    config = settings(plaid_client_id=None)
    services = default_services(config)
    assert services.provider_for is not None
    with pytest.raises(PlaidNotConfigured):
        services.provider_for(secrets(config))


def test_items_without_a_token_or_from_another_provider_are_refused() -> None:
    config = settings()
    services = default_services(config)
    assert services.provider_for is not None
    tokenless = SyncItemSecrets(
        id=uuid.uuid4(), provider=SyncProvider.PLAID, provider_item_id="x", access_token_enc=None
    )
    with pytest.raises(ValueError, match="access token"):
        services.provider_for(tokenless)
    with pytest.raises(ValueError, match="csv"):
        services.provider_for(secrets(config, provider=SyncProvider.CSV))


def test_the_gateway_follows_llm_fake() -> None:
    assert isinstance(default_services(settings()).labeler, FakeGateway)
    real = default_services(
        settings(llm_fake=False, anthropic_api_key=SecretStr("sk-ant-test"))
    ).labeler
    assert type(real) is LLMGateway


def test_no_gateway_without_a_key(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING):
        services = default_services(settings(llm_fake=False, anthropic_api_key=None))
    assert services.labeler is None
    assert "ANTHROPIC_API_KEY" in caplog.text
