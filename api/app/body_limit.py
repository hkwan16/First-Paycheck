"""Bound every request body (spec 004 rule 2 for uploads; M10 for the rest).

FastAPI reads and parses a body (JSON or multipart) before any dependency or
route code runs, so the limit has to sit in front of the app. Two checks:

* a declared ``Content-Length`` over the limit is refused with 413 before a
  byte is read;
* the bytes actually received are counted, so a chunked body with no
  ``Content-Length`` (or one that lies) is cut off at the limit: the wrapped
  ``receive`` raises ``BodyTooLarge``, an ``HTTPException`` that FastAPI passes
  through its body parsing and ``app/errors.py`` renders as 413.

Uploads (``POST /docs``, ``POST /accounts/import``) have their own larger
limit and keep their ``file_too_large`` code; every other request with a body
gets ``DEFAULT_MAX_BODY_BYTES`` and ``body_too_large``. The upload routes still
measure the file itself.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.errors import error_body

# The largest JSON body any route needs is a confirm with its line items, a few
# kilobytes; 1 MB also bounds the Plaid webhook before its signature is checked.
DEFAULT_MAX_BODY_BYTES = 1_000_000
_NO_BODY = frozenset({"GET", "HEAD", "OPTIONS"})


@dataclass(frozen=True)
class BodyRule:
    max_bytes: int
    code: str
    message: str


DEFAULT_RULE = BodyRule(
    max_bytes=DEFAULT_MAX_BODY_BYTES,
    code="body_too_large",
    message="The request body is larger than 1 MB",
)


class BodyTooLarge(HTTPException):
    """Raised from ``receive`` once the body passes its limit."""

    def __init__(self, rule: BodyRule) -> None:
        super().__init__(status_code=413, detail=rule.message)
        self.code = rule.code


def too_large_response(rule: BodyRule) -> JSONResponse:
    return JSONResponse(error_body(rule.code, rule.message), status_code=413)


class BodySizeLimit:
    """413 for a request whose body is over its path's rule, else ``default``."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        paths: Mapping[str, BodyRule],
        default: BodyRule = DEFAULT_RULE,
    ) -> None:
        self.app = app
        self.paths = dict(paths)
        self.default = default

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] in _NO_BODY:
            await self.app(scope, receive, send)
            return
        rule = self.paths.get(scope["path"], self.default)
        if self._declared_length(scope) > rule.max_bytes:
            await too_large_response(rule)(scope, receive, send)
            return
        received = 0

        async def counted() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > rule.max_bytes:
                    raise BodyTooLarge(rule)
            return message

        await self.app(scope, counted, send)

    @staticmethod
    def _declared_length(scope: Scope) -> int:
        for name, value in scope["headers"]:
            if name == b"content-length":
                text = value.decode("latin-1").strip()
                return int(text) if text.isdigit() else 0
        return 0
