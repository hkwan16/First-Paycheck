"""A ``FakeGateway`` that records what it was sent, for extraction tests."""

from __future__ import annotations

from typing import Any

from sqlalchemy import Connection

from app.config import Settings
from llm.gateway import Content, FakeGateway, Reply
from llm.prompts import Prompt


class SpyGateway(FakeGateway):
    """Keeps every request's content and can answer with a fixed reply or error.

    It goes through the real budget, validation and ledger code: ``settings``
    overrides (``llm_daily_budget_cents=0``) behave as they would in production.
    """

    def __init__(
        self,
        connection: Connection,
        *,
        reply: Reply | None = None,
        error: Exception | None = None,
        **settings: Any,
    ) -> None:
        super().__init__(Settings(_env_file=None, llm_fake=True, **settings), bind=connection)
        self.contents: list[Content] = []
        self._reply = reply
        self._error = error

    def _send(self, prompt: Prompt, model: str, content: Content) -> Reply:
        self.contents.append(content)
        if self._error is not None:
            raise self._error
        if self._reply is not None:
            return self._reply
        return super()._send(prompt, model, content)
