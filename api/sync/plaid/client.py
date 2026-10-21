# plaid-python ships no type information (no py.typed); this module is the only
# place that imports it, so the exemption is scoped here.
# mypy: disable-error-code="import-untyped"
"""A thin client over plaid-python that returns parsed JSON with Decimal money.

plaid-python's generated models parse amounts as ``float``; every call here asks
for the raw response instead and parses it with ``parse_float=Decimal`` (spec 002
rule 2). Errors become ``PlaidError`` carrying Plaid's code, type, message and
request id, and never the request (which holds the access token) or a chained
library exception (whose ``str`` includes response headers).
"""

from __future__ import annotations

import json
from decimal import Decimal
from typing import TYPE_CHECKING, Any, Protocol

import plaid
import urllib3
from plaid.api.plaid_api import PlaidApi
from plaid.model.accounts_get_request import AccountsGetRequest
from plaid.model.country_code import CountryCode
from plaid.model.institutions_get_by_id_request import InstitutionsGetByIdRequest
from plaid.model.investments_holdings_get_request import InvestmentsHoldingsGetRequest
from plaid.model.item_public_token_exchange_request import ItemPublicTokenExchangeRequest
from plaid.model.item_remove_request import ItemRemoveRequest
from plaid.model.link_token_create_request import LinkTokenCreateRequest
from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser
from plaid.model.link_token_transactions import LinkTokenTransactions
from plaid.model.products import Products
from plaid.model.sandbox_public_token_create_request import SandboxPublicTokenCreateRequest
from plaid.model.sandbox_public_token_create_request_options import (
    SandboxPublicTokenCreateRequestOptions,
)
from plaid.model.transactions_sync_request import TransactionsSyncRequest
from plaid.model.webhook_verification_key_get_request import WebhookVerificationKeyGetRequest
from pydantic import SecretStr

from sync.provider import ProviderError

if TYPE_CHECKING:
    from app.config import Settings

PLAID_VERSION = "2020-09-14"
CLIENT_NAME = "First Paycheck"
# (connect, read) seconds. /transactions/sync pages of 500 can take a while.
TIMEOUT = (5.0, 60.0)
SYNC_PAGE_SIZE = 500
HISTORY_DAYS = 730

__all__ = ["PlaidClient", "PlaidError", "PlaidLinking", "PlaidNotConfigured"]


class PlaidLinking(Protocol):
    """The part of PlaidClient the API routes use (linking, unlinking, webhooks)."""

    def link_token_create(self, *, user_id: str, webhook: str | None) -> dict[str, str]: ...

    def item_public_token_exchange(self, public_token: str) -> tuple[SecretStr, str]: ...

    def sandbox_public_token_create(
        self, institution_id: str, *, webhook: str | None = None
    ) -> str: ...

    def institution_name(self, institution_id: str) -> str: ...

    def item_remove(self, access_token: SecretStr) -> None: ...

    def webhook_verification_key_get(self, key_id: str) -> dict[str, Any]: ...


class PlaidNotConfigured(RuntimeError):
    """PLAID_CLIENT_ID or PLAID_SECRET is missing."""


class PlaidError(ProviderError):
    """A Plaid API error, or a network failure talking to Plaid."""

    def __init__(
        self,
        *,
        code: str,
        error_type: str,
        message: str,
        request_id: str | None,
        status: int | None = None,
    ) -> None:
        self.code = code
        self.error_type = error_type
        self.message = message
        self.request_id = request_id
        self.status = status
        super().__init__(f"{code} ({error_type}): {message} [request_id={request_id}]")


class PlaidClient:
    def __init__(self, api: PlaidApi) -> None:
        self.api = api

    @classmethod
    def from_settings(cls, settings: Settings) -> PlaidClient:
        if not settings.plaid_client_id or settings.plaid_secret is None:
            raise PlaidNotConfigured("PLAID_CLIENT_ID and PLAID_SECRET must be set to use Plaid")
        host = (
            plaid.Environment.Production
            if settings.plaid_env == "production"
            else plaid.Environment.Sandbox
        )
        configuration = plaid.Configuration(
            host=host,
            api_key={
                "clientId": settings.plaid_client_id,
                "secret": settings.plaid_secret.get_secret_value(),
                "plaidVersion": PLAID_VERSION,
            },
        )
        return cls(PlaidApi(plaid.ApiClient(configuration)))

    # Item data -------------------------------------------------------------

    def accounts_get(self, access_token: SecretStr) -> dict[str, Any]:
        request = AccountsGetRequest(access_token=access_token.get_secret_value())
        return self._call("accounts_get", request)

    def transactions_sync(self, access_token: SecretStr, cursor: str | None) -> dict[str, Any]:
        fields: dict[str, Any] = {"count": SYNC_PAGE_SIZE}
        if cursor is not None:
            fields["cursor"] = cursor
        request = TransactionsSyncRequest(access_token=access_token.get_secret_value(), **fields)
        return self._call("transactions_sync", request)

    def investments_holdings_get(self, access_token: SecretStr) -> dict[str, Any]:
        request = InvestmentsHoldingsGetRequest(access_token=access_token.get_secret_value())
        return self._call("investments_holdings_get", request)

    # Linking ---------------------------------------------------------------

    def link_token_create(self, *, user_id: str, webhook: str | None) -> dict[str, str]:
        fields: dict[str, Any] = {}
        if webhook:
            fields["webhook"] = webhook
        request = LinkTokenCreateRequest(
            client_name=CLIENT_NAME,
            language="en",
            country_codes=[CountryCode("US")],
            user=LinkTokenCreateRequestUser(client_user_id=user_id),
            products=[Products("transactions")],
            optional_products=[Products("investments")],
            transactions=LinkTokenTransactions(days_requested=HISTORY_DAYS),
            **fields,
        )
        body = self._call("link_token_create", request)
        return {"link_token": str(body["link_token"]), "expiration": str(body["expiration"])}

    def item_public_token_exchange(self, public_token: str) -> tuple[SecretStr, str]:
        request = ItemPublicTokenExchangeRequest(public_token=public_token)
        body = self._call("item_public_token_exchange", request)
        return SecretStr(str(body["access_token"])), str(body["item_id"])

    def sandbox_public_token_create(
        self, institution_id: str, *, webhook: str | None = None
    ) -> str:
        fields: dict[str, Any] = {}
        if webhook:
            fields["options"] = SandboxPublicTokenCreateRequestOptions(webhook=webhook)
        request = SandboxPublicTokenCreateRequest(
            institution_id=institution_id,
            initial_products=[Products("transactions"), Products("investments")],
            **fields,
        )
        return str(self._call("sandbox_public_token_create", request)["public_token"])

    def institution_name(self, institution_id: str) -> str:
        request = InstitutionsGetByIdRequest(
            institution_id=institution_id, country_codes=[CountryCode("US")]
        )
        return str(self._call("institutions_get_by_id", request)["institution"]["name"])

    def item_remove(self, access_token: SecretStr) -> None:
        self._call("item_remove", ItemRemoveRequest(access_token=access_token.get_secret_value()))

    def webhook_verification_key_get(self, key_id: str) -> dict[str, Any]:
        request = WebhookVerificationKeyGetRequest(key_id=key_id)
        key: dict[str, Any] = self._call("webhook_verification_key_get", request)["key"]
        return key

    # Transport -------------------------------------------------------------

    def _call(self, operation: str, request: Any) -> dict[str, Any]:
        endpoint = getattr(self.api, operation)
        try:
            response = endpoint(request, _preload_content=False, _request_timeout=TIMEOUT)
        except plaid.ApiException as exc:
            raise _api_error(exc) from None
        except urllib3.exceptions.HTTPError as exc:
            raise _network_error(type(exc).__name__) from None
        try:
            body: dict[str, Any] = json.loads(response.data, parse_float=Decimal)
        except ValueError:
            raise PlaidError(
                code="UNKNOWN",
                error_type="API_ERROR",
                message="Plaid returned a body that is not JSON",
                request_id=None,
                status=response.status,
            ) from None
        return body


def _network_error(reason: str) -> PlaidError:
    return PlaidError(
        code="NETWORK_ERROR",
        error_type="NETWORK_ERROR",
        message=f"could not reach Plaid ({reason})",
        request_id=None,
    )


def _api_error(exc: plaid.ApiException) -> PlaidError:
    if not exc.status:
        # plaid-python reports SSL and transport failures as status 0.
        return _network_error("transport error")
    try:
        body = json.loads(exc.body or b"")
    except ValueError:
        body = None
    if not isinstance(body, dict) or not isinstance(body.get("error_code"), str):
        return PlaidError(
            code="UNKNOWN",
            error_type="API_ERROR",
            message=f"Plaid returned HTTP {exc.status}",
            request_id=None,
            status=exc.status,
        )
    return PlaidError(
        code=body["error_code"],
        error_type=str(body.get("error_type") or "UNKNOWN"),
        message=str(body.get("error_message") or ""),
        request_id=body.get("request_id"),
        status=exc.status,
    )
