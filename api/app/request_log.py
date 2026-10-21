"""One log line per HTTP request, and the request id that ties lines together.

``RequestLogging`` is the outermost middleware the app adds. It takes the
request id from an ``X-Request-Id`` header when the value is a plain token
(letters, digits, ``.``, ``_``, ``:``, ``-``, at most 128 characters) and
makes one otherwise, binds it with ``log_context`` for every line written
while the request runs, returns it in the response's ``X-Request-Id`` and,
when the response is done, logs ``app.request`` with ``method``, ``path`` (no
query string), ``status``, ``duration_ms``, ``request_id`` and, once the
bearer token verified, ``user_id``. Headers and bodies are never logged.

An unhandled exception propagates past this middleware to Starlette's
outermost error handler, so the id is also kept in the request's state, where
``app.errors`` reads it for the 500 response and its traceback line.
"""

from __future__ import annotations

import logging
import re
import time
import uuid
from typing import Any

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.logs import log_context

__all__ = ["REQUEST_ID_HEADER", "RequestLogging", "request_id_of", "user_id_of"]

REQUEST_ID_HEADER = "X-Request-Id"
_INCOMING_ID = re.compile(r"[A-Za-z0-9._:-]{1,128}")

logger = logging.getLogger("app.request")


def _state(scope: Scope) -> dict[str, Any]:
    # Starlette's ``request.state`` reads and writes this dict.
    state: dict[str, Any] = scope.setdefault("state", {})
    return state


def request_id_of(scope: Scope) -> str | None:
    value = _state(scope).get("request_id")
    return value if isinstance(value, str) else None


def user_id_of(scope: Scope) -> str | None:
    """Set by ``app.auth.get_current_user`` once the token verified."""
    value = _state(scope).get("user_id")
    return value if isinstance(value, str) else None


def _incoming_id(scope: Scope) -> str | None:
    for name, value in scope["headers"]:
        if name == b"x-request-id":
            text = value.decode("latin-1")
            return text if _INCOMING_ID.fullmatch(text) else None
    return None


class RequestLogging:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request_id = _incoming_id(scope) or uuid.uuid4().hex
        _state(scope)["request_id"] = request_id
        started = time.perf_counter()
        # Until a response starts, the outcome is the 500 an exception becomes.
        status = 500

        async def send_with_id(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                MutableHeaders(scope=message)[REQUEST_ID_HEADER] = request_id
            await send(message)

        with log_context(request_id=request_id):
            try:
                await self.app(scope, receive, send_with_id)
            finally:
                fields: dict[str, Any] = {
                    "method": scope["method"],
                    "path": scope["path"],
                    "status": status,
                    "duration_ms": round((time.perf_counter() - started) * 1000, 1),
                    "request_id": request_id,
                }
                if (user_id := user_id_of(scope)) is not None:
                    fields["user_id"] = user_id
                logger.info("request", extra=fields)
