"""The worker's real collaborators, built once from settings.

A missing Plaid credential never stops the worker: Plaid and the token cipher are
built on first use, so a sync job fails with a clear error and is retried,
while every other job kind keeps running. The gateway is built at startup.
Outside production, without ``ANTHROPIC_API_KEY`` (and with ``LLM_FAKE`` off)
there is none, so categorize runs its rules only (``stopped: "no_model"``) and
extraction goes to manual entry (``no_model``) until the key is set (specs 003
rule 12a, 005 rule 12). Production never gets here without a key: settings
refuse to load (``app/config.py``). A key the API rejects ends those jobs the
same way, call by call, in every environment.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable

from app.config import Settings
from db.enums import SyncProvider as SyncProviderKind
from jobs.context import Services
from llm.gateway import Gateway, LLMNotConfigured, get_gateway
from sync.crypto import TokenCipher, cipher_from_settings
from sync.pipeline import ProviderFactory, SyncItemSecrets
from sync.plaid.client import PlaidClient
from sync.plaid.provider import PlaidProvider
from sync.provider import SyncProvider

log = logging.getLogger(__name__)


def _once[T](build: Callable[[], T]) -> Callable[[], T]:
    """Build on first call and reuse; a failed build is retried next time."""
    lock = threading.Lock()
    built: list[T] = []

    def get() -> T:
        with lock:
            if not built:
                built.append(build())
            return built[0]

    return get


def plaid_provider_factory(settings: Settings) -> ProviderFactory:
    client = _once(lambda: PlaidClient.from_settings(settings))
    cipher: Callable[[], TokenCipher] = _once(lambda: cipher_from_settings(settings))

    def provider_for(item: SyncItemSecrets) -> SyncProvider:
        if item.provider is not SyncProviderKind.PLAID:
            raise ValueError(f"no sync provider for {item.provider.value} items")
        if item.access_token_enc is None:
            raise ValueError("this Plaid item has no access token")
        return PlaidProvider(client(), cipher().decrypt(item.access_token_enc))

    return provider_for


def default_services(settings: Settings) -> Services:
    try:
        gateway: Gateway | None = get_gateway(settings)
    except LLMNotConfigured as exc:
        log.warning("no model: categorize runs rules only, extraction is manual: %s", exc)
        gateway = None
    return Services(
        provider_for=plaid_provider_factory(settings), labeler=gateway, extractor=gateway
    )
