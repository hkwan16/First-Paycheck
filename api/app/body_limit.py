"""Refuse an oversized upload from its ``Content-Length`` before reading it
(spec 004 rule 2).

FastAPI parses a multipart body before any dependency or route code runs, so
the check has to sit in front of the app. The route still measures the file
itself, which also covers bodies sent without a ``Content-Length``.
"""

from __future__ import annotations

from collections.abc import Iterable

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app.errors import error_body


class BodySizeLimit:
    """413 ``file_too_large`` for a POST to one of ``paths`` whose declared
    length exceeds ``max_bytes``."""

    def __init__(self, app: ASGIApp, *, paths: Iterable[str], max_bytes: int, message: str) -> None:
        self.app = app
        self.paths = frozenset(paths)
        self.max_bytes = max_bytes
        self.message = message

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] == "http"
            and scope["method"] == "POST"
            and scope["path"] in self.paths
            and self._declared_length(scope) > self.max_bytes
        ):
            response = JSONResponse(error_body("file_too_large", self.message), status_code=413)
            await response(scope, receive, send)
            return
        await self.app(scope, receive, send)

    @staticmethod
    def _declared_length(scope: Scope) -> int:
        for name, value in scope["headers"]:
            if name == b"content-length":
                text = value.decode("latin-1").strip()
                return int(text) if text.isdigit() else 0
        return 0
