"""The real ``LLMGateway`` in front of a Messages API that answers every request
with one HTTP error, for job tests that must see exactly what production sees.

The SDK is built on httpx2, which respx cannot patch, so the API is an
``httpx2.MockTransport`` handed to the SDK as its HTTP client. Everything above
the transport (the SDK's error mapping, the gateway's ledger) is the real code.
"""

from __future__ import annotations

import httpx2
from pydantic import SecretStr
from sqlalchemy import Connection

from app.config import Settings
from llm.gateway import LLMGateway

# The error ``type`` Anthropic sends with each status.
ERROR_TYPES = {
    400: "invalid_request_error",
    401: "authentication_error",
    403: "permission_error",
    404: "not_found_error",
    429: "rate_limit_error",
    500: "api_error",
    529: "overloaded_error",
}


class ErroringApi:
    """Answers every request with ``status`` and Anthropic's error body; counts them."""

    def __init__(self, status: int) -> None:
        self.status = status
        self.requests = 0

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests += 1
        body = {
            "type": "error",
            "error": {"type": ERROR_TYPES[self.status], "message": "synthetic error"},
        }
        return httpx2.Response(self.status, json=body)


def api_gateway(connection: Connection, api: ErroringApi) -> LLMGateway:
    """A real gateway with a test key whose HTTP calls go to ``api``."""
    settings = Settings(
        _env_file=None,
        anthropic_api_key=SecretStr("sk-ant-test"),
        llm_fake=False,
        llm_daily_budget_cents=50,
    )
    return LLMGateway(
        settings,
        bind=connection,
        http_client=httpx2.Client(transport=httpx2.MockTransport(api)),
        max_retries=0,
    )
