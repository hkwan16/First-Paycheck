"""The only door to Claude (spec 003 rules 19-27).

Every call: check the user's daily budget, send one structured-output request
with a cached system prompt, branch on ``stop_reason == "refusal"`` before
reading anything, validate the reply against the prompt's schema, and write one
``llm_calls`` row in its own committed session. No prompt or output text is
ever stored or logged.

The SDK's ``messages.parse`` helper validates the reply inside the call, so a
refusal whose text is not JSON raises before ``stop_reason`` can be read and
the call's usage is lost. The gateway therefore calls ``messages.create`` with
``output_config.format`` built by ``anthropic.transform_schema`` (the same
schema ``parse`` would send) and validates the text itself.

``FakeGateway`` (``LLM_FAKE=true``) shares the budget check, validation and
ledger; it replaces only the HTTP call with fixture answers.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import time
import uuid
from abc import ABC, abstractmethod
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path
from typing import Any, TypeVar

import anthropic
import httpx2
from pydantic import BaseModel, ValidationError
from sqlalchemy import Connection, Engine, func, select

from app.config import REPO_ROOT, Settings
from app.db import user_session_for
from db.enums import LlmPurpose, LlmStatus
from db.models import LlmCall
from llm.cost import cost_microcents, price_for
from llm.prompts import Prompt, load_prompt
from llm.schemas import CategoryAssignment, CategoryBatch

log = logging.getLogger(__name__)

CATEGORIZE_PROMPT = ("categorize", "v1")
REQUEST_TIMEOUT_SECONDS = 60.0
MICROCENTS_PER_CENT = 1_000_000
FAKE_MODEL = "fake"
FAKE_FIXTURES = REPO_ROOT / "api" / "tests" / "fixtures" / "llm"
FAKE_DEFAULT = ("other", 0.5)

Schema = TypeVar("Schema", bound=BaseModel)
Clock = Callable[[], dt.datetime]

__all__ = [
    "CategorizeItem",
    "FakeGateway",
    "Gateway",
    "LLMBudgetExceeded",
    "LLMError",
    "LLMGateway",
    "LLMNotConfigured",
    "LLMRefused",
    "LLMSchemaError",
    "LLMUnavailable",
    "Usage",
    "get_gateway",
]


class LLMNotConfigured(RuntimeError):
    """ANTHROPIC_API_KEY is missing and LLM_FAKE is off."""


class LLMError(Exception):
    """A call failed in a way retrying the same request will not fix."""


class LLMBudgetExceeded(LLMError):
    """The user has spent today's LLM budget; nothing was sent."""


class LLMRefused(LLMError):
    """The model declined the request (``stop_reason == "refusal"``)."""


class LLMSchemaError(LLMError):
    """The reply was missing, not JSON, or did not match the schema."""


class LLMUnavailable(LLMError):
    """Rate limited, overloaded, timed out or unreachable; worth retrying later."""


@dataclass(frozen=True)
class CategorizeItem:
    """One distinct merchant to label: the only data the model sees (rule 9)."""

    id: int
    merchant: str
    amount_cents: int
    date: dt.date

    def as_request(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "merchant": self.merchant,
            "amount": _dollars(self.amount_cents),
            "date": self.date.isoformat(),
        }


@dataclass(frozen=True)
class TextPage:
    """A text-layer page, already redacted (spec 004 rule 17)."""

    number: int
    text: str


@dataclass(frozen=True)
class ImagePage:
    """A page image as PNG bytes, already redacted in the image (spec 004 rule 17)."""

    number: int
    png: bytes

    def __repr__(self) -> str:
        return f"ImagePage(number={self.number}, png=<{len(self.png)} bytes>)"


ModelPage = TextPage | ImagePage


@dataclass(frozen=True)
class Usage:
    """Token counts. ``input_tokens`` is uncached input only."""

    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0


@dataclass(frozen=True)
class Reply:
    stop_reason: str | None
    text: str | None
    usage: Usage


def _dollars(cents: int) -> str:
    sign = "-" if cents < 0 else ""
    whole, part = divmod(abs(cents), 100)
    return f"{sign}{whole}.{part:02d}"


def _utc_now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


class Gateway(ABC):
    """Budget, validation and ledger; subclasses supply the model call."""

    def __init__(
        self,
        settings: Settings,
        *,
        bind: Engine | Connection | None = None,
        clock: Clock = _utc_now,
    ) -> None:
        self._settings = settings
        self._bind = bind
        self._clock = clock

    # Public methods, one per prompt ------------------------------------------

    def categorize(
        self,
        user_id: uuid.UUID,
        items: Sequence[CategorizeItem],
        *,
        job_id: uuid.UUID | None = None,
    ) -> CategoryBatch:
        if not items:
            return CategoryBatch(items=[])
        content = json.dumps({"items": [item.as_request() for item in items]})
        prompt = load_prompt(*CATEGORIZE_PROMPT)
        return self._call(prompt, CategoryBatch, user_id=user_id, job_id=job_id, content=content)

    # The call ----------------------------------------------------------------

    def _call(
        self,
        prompt: Prompt,
        schema: type[Schema],
        *,
        user_id: uuid.UUID,
        job_id: uuid.UUID | None,
        content: str,
    ) -> Schema:
        if prompt.schema is not schema:
            raise TypeError(f"{prompt.version} declares {prompt.schema.__name__}, not {schema}")
        model = self._model_for(prompt.purpose)
        self._check_model(model)

        def record(status: LlmStatus, usage: Usage, started: float | None) -> None:
            latency = 0 if started is None else round((time.monotonic() - started) * 1000)
            self._record(
                user_id=user_id,
                job_id=job_id,
                prompt=prompt,
                model=model,
                status=status,
                usage=usage,
                latency_ms=latency,
            )

        if (
            self._spent_today(user_id)
            >= self._settings.llm_daily_budget_cents * MICROCENTS_PER_CENT
        ):
            record(LlmStatus.BUDGET_BLOCKED, Usage(), None)
            raise LLMBudgetExceeded("today's LLM budget is spent")

        started = time.monotonic()
        try:
            reply = self._send(prompt, model, content)
        except LLMError:
            record(LlmStatus.API_ERROR, Usage(), started)
            raise
        if reply.stop_reason == "refusal":
            record(LlmStatus.REFUSAL, reply.usage, started)
            raise LLMRefused(f"the model declined the {prompt.version} request")
        try:
            if reply.text is None:
                raise ValueError("no text block")
            result = schema.model_validate_json(reply.text)
        except (ValidationError, ValueError):
            record(LlmStatus.SCHEMA_ERROR, reply.usage, started)
            raise LLMSchemaError(
                f"the {prompt.version} reply did not match {schema.__name__}"
            ) from None
        record(LlmStatus.OK, reply.usage, started)
        return result

    # Hooks -------------------------------------------------------------------

    def _model_for(self, purpose: LlmPurpose) -> str:
        model: str = getattr(self._settings, f"llm_model_{purpose.value}")
        return model

    def _check_model(self, model: str) -> None:
        price_for(model)

    def _cost(self, model: str, usage: Usage) -> int:
        return cost_microcents(
            model,
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
            cache_read_tokens=usage.cache_read_tokens,
            cache_write_tokens=usage.cache_write_tokens,
        )

    @abstractmethod
    def _send(self, prompt: Prompt, model: str, content: str) -> Reply:
        """Make the model call. Raise ``LLMUnavailable`` or ``LLMError`` on failure."""

    # Ledger ------------------------------------------------------------------

    def _spent_today(self, user_id: uuid.UUID) -> int:
        today = self._clock().astimezone(dt.UTC).date()
        start = dt.datetime.combine(today, dt.time.min, tzinfo=dt.UTC)
        with user_session_for(user_id, bind=self._bind) as session:
            spent = session.scalar(
                select(func.coalesce(func.sum(LlmCall.cost_microcents), 0)).where(
                    LlmCall.user_id == user_id, LlmCall.created_at >= start
                )
            )
        return int(spent or 0)

    def _record(
        self,
        *,
        user_id: uuid.UUID,
        job_id: uuid.UUID | None,
        prompt: Prompt,
        model: str,
        status: LlmStatus,
        usage: Usage,
        latency_ms: int,
    ) -> None:
        # Its own short session, committed at once: a later failure in the
        # caller cannot erase the charge.
        with user_session_for(user_id, bind=self._bind) as session:
            session.add(
                LlmCall(
                    user_id=user_id,
                    purpose=prompt.purpose,
                    model=model,
                    prompt_version=prompt.version,
                    input_tokens=usage.input_tokens + usage.cache_write_tokens,
                    output_tokens=usage.output_tokens,
                    cache_read_tokens=usage.cache_read_tokens,
                    cost_microcents=self._cost(model, usage),
                    latency_ms=latency_ms,
                    status=status,
                    job_id=job_id,
                    created_at=self._clock(),
                )
            )
        log.info(
            "llm call %s %s status=%s latency_ms=%d",
            prompt.version,
            model,
            status.value,
            latency_ms,
        )


class LLMGateway(Gateway):
    """Calls the Anthropic Messages API."""

    def __init__(
        self,
        settings: Settings,
        *,
        bind: Engine | Connection | None = None,
        clock: Clock = _utc_now,
        http_client: httpx2.Client | None = None,
        max_retries: int = 2,
    ) -> None:
        super().__init__(settings, bind=bind, clock=clock)
        if settings.anthropic_api_key is None:
            raise LLMNotConfigured("ANTHROPIC_API_KEY must be set unless LLM_FAKE=true")
        self._client = anthropic.Anthropic(
            api_key=settings.anthropic_api_key.get_secret_value(),
            max_retries=max_retries,
            timeout=REQUEST_TIMEOUT_SECONDS,
            http_client=http_client,
        )

    def _send(self, prompt: Prompt, model: str, content: str) -> Reply:
        try:
            response = self._client.messages.create(
                model=model,
                max_tokens=prompt.max_tokens,
                system=[
                    {
                        "type": "text",
                        "text": prompt.system,
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
                messages=[{"role": "user", "content": content}],
                output_config={
                    "effort": prompt.effort,
                    "format": {
                        "type": "json_schema",
                        "schema": anthropic.transform_schema(prompt.schema),
                    },
                },
            )
        except anthropic.APIStatusError as exc:
            status = exc.status_code
            message = f"Anthropic API returned HTTP {status} ({type(exc).__name__})"
            if status == 429 or status >= 500:
                raise LLMUnavailable(message) from None
            raise LLMError(message) from None
        except anthropic.APIConnectionError as exc:
            raise LLMUnavailable(
                f"could not reach the Anthropic API ({type(exc).__name__})"
            ) from None

        usage = response.usage
        text = next((block.text for block in response.content if block.type == "text"), None)
        return Reply(
            stop_reason=response.stop_reason,
            text=text,
            usage=Usage(
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
                cache_read_tokens=usage.cache_read_input_tokens or 0,
                cache_write_tokens=usage.cache_creation_input_tokens or 0,
            ),
        )


class FakeGateway(Gateway):
    """Answers from ``api/tests/fixtures/llm/`` at zero cost (``LLM_FAKE=true``)."""

    def __init__(
        self,
        settings: Settings,
        *,
        bind: Engine | Connection | None = None,
        clock: Clock = _utc_now,
        fixtures: Path = FAKE_FIXTURES,
    ) -> None:
        super().__init__(settings, bind=bind, clock=clock)
        self._fixtures = fixtures

    def _model_for(self, purpose: LlmPurpose) -> str:
        return FAKE_MODEL

    def _check_model(self, model: str) -> None:
        return None

    def _cost(self, model: str, usage: Usage) -> int:
        return 0

    def _send(self, prompt: Prompt, model: str, content: str) -> Reply:
        if prompt.schema is not CategoryBatch:
            raise LLMError(f"FakeGateway has no answers for {prompt.version}")
        items = json.loads(content)["items"]
        answers = [
            CategoryAssignment.model_validate(
                {"id": item["id"], **self._categories.get(item["merchant"], _fake_default())}
            )
            for item in items
        ]
        return Reply(
            stop_reason="end_turn",
            text=CategoryBatch(items=answers).model_dump_json(),
            usage=Usage(),
        )

    @cached_property
    def _categories(self) -> Mapping[str, Mapping[str, Any]]:
        path = self._fixtures / "categorize.json"
        try:
            data: dict[str, dict[str, Any]] = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            log.warning("FakeGateway: %s is missing; every merchant is 'other'", path)
            return {}
        return data


def _fake_default() -> dict[str, Any]:
    category, confidence = FAKE_DEFAULT
    return {"category": category, "confidence": confidence}


def get_gateway(settings: Settings, *, bind: Engine | Connection | None = None) -> Gateway:
    """``FakeGateway`` when ``LLM_FAKE`` is on, otherwise the real one."""
    if settings.llm_fake:
        return FakeGateway(settings, bind=bind)
    return LLMGateway(settings, bind=bind)
