"""The only door to Claude (spec 003 rules 19-27, spec 005 rules 6-8).

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

Extraction requests carry already-redacted pages only: page images as base64
PNG ``image`` blocks first, then one ``text`` block with the text pages.

``FakeGateway`` (``LLM_FAKE=true``) shares the budget check, validation and
ledger; it replaces only the HTTP call with fixture answers. The ledger is the
``llm_calls`` table (``DbLedger``) everywhere except the eval runner, which
has no database and passes a ``MemoryLedger``.
"""

from __future__ import annotations

import base64
import datetime as dt
import json
import logging
import time
import uuid
from abc import ABC, abstractmethod
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path
from typing import Any, Protocol, TypeVar

import anthropic
import httpx2
from anthropic.types import ContentBlockParam
from pydantic import BaseModel, ValidationError
from sqlalchemy import Connection, Engine, func, select

from app.config import REPO_ROOT, Settings
from app.db import user_session_for
from db.enums import LlmPurpose, LlmStatus
from db.models import LlmCall
from llm.cost import cost_microcents, price_for
from llm.prompts import Prompt, load_prompt
from llm.schemas import (
    BenefitsSummaryExtraction,
    CategoryAssignment,
    CategoryBatch,
    ExplainContext,
    ExplanationDraft,
    NumberClaim,
    PayStubExtraction,
)

log = logging.getLogger(__name__)

CATEGORIZE_PROMPT = ("categorize", "v1")
EXTRACT_PAY_STUB_PROMPT = ("extract_pay_stub", "v1")
EXTRACT_BENEFITS_PROMPT = ("extract_benefits", "v2")
EXPLAIN_PROMPT = ("explain", "v1")
REQUEST_TIMEOUT_SECONDS = 120.0
MICROCENTS_PER_CENT = 1_000_000
FAKE_MODEL = "fake"
FAKE_FIXTURES = REPO_ROOT / "api" / "tests" / "fixtures" / "llm"
FAKE_DEFAULT = ("other", 0.5)
# How many facts FakeGateway's explanation states.
FAKE_EXPLAIN_FACTS = 4

Schema = TypeVar("Schema", bound=BaseModel)
Clock = Callable[[], dt.datetime]
# A user message's content: plain text, or a list of content blocks.
Content = str | list[ContentBlockParam]

__all__ = [
    "REFUSAL_REPLY",
    "CategorizeItem",
    "DbLedger",
    "FakeGateway",
    "Gateway",
    "ImagePage",
    "LLMBudgetExceeded",
    "LLMError",
    "LLMGateway",
    "LLMNotConfigured",
    "LLMRefused",
    "LLMSchemaError",
    "LLMUnavailable",
    "Ledger",
    "LedgerEntry",
    "MemoryLedger",
    "ModelPage",
    "Reply",
    "ScriptStep",
    "ScriptedGateway",
    "TextPage",
    "Usage",
    "get_gateway",
    "reply_with",
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


def _day_start(moment: dt.datetime) -> dt.datetime:
    return dt.datetime.combine(moment.astimezone(dt.UTC).date(), dt.time.min, tzinfo=dt.UTC)


def page_content(pages: Sequence[ModelPage]) -> list[ContentBlockParam]:
    """Image blocks in page order, then one text block naming the image pages
    and holding every text page under its number (spec 005 rule 6)."""
    images = [page for page in pages if isinstance(page, ImagePage)]
    texts = [page for page in pages if isinstance(page, TextPage)]
    blocks: list[ContentBlockParam] = [
        {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": base64.b64encode(page.png).decode("ascii"),
            },
        }
        for page in images
    ]
    parts: list[str] = []
    if images:
        numbers = ", ".join(str(page.number) for page in images)
        parts.append(f"Images above: pages {numbers} (redacted page images, in order).")
    parts.extend(f"Page {page.number} (text layer):\n{page.text}" for page in texts)
    parts.append("Read the document described in your instructions.")
    blocks.append({"type": "text", "text": "\n\n".join(parts)})
    return blocks


# ---------------------------------------------------------------- the ledger


@dataclass(frozen=True)
class LedgerEntry:
    """One call's accounting: counts, cost and status, never text."""

    user_id: uuid.UUID
    job_id: uuid.UUID | None
    purpose: LlmPurpose
    model: str
    prompt_version: str
    status: LlmStatus
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cost_microcents: int
    latency_ms: int
    created_at: dt.datetime


class Ledger(Protocol):
    def spent_today(self, user_id: uuid.UUID) -> int:
        """Microcents the user has spent since the current UTC midnight."""
        ...

    def record(self, entry: LedgerEntry) -> None: ...


class DbLedger:
    """The ``llm_calls`` table, written as the user (spec 003 rule 25)."""

    def __init__(self, *, bind: Engine | Connection | None = None, clock: Clock = _utc_now) -> None:
        self._bind = bind
        self._clock = clock

    def spent_today(self, user_id: uuid.UUID) -> int:
        start = _day_start(self._clock())
        with user_session_for(user_id, bind=self._bind) as session:
            spent = session.scalar(
                select(func.coalesce(func.sum(LlmCall.cost_microcents), 0)).where(
                    LlmCall.user_id == user_id, LlmCall.created_at >= start
                )
            )
        return int(spent or 0)

    def record(self, entry: LedgerEntry) -> None:
        # Its own short session, committed at once: a later failure in the
        # caller cannot erase the charge.
        with user_session_for(entry.user_id, bind=self._bind) as session:
            session.add(
                LlmCall(
                    user_id=entry.user_id,
                    purpose=entry.purpose,
                    model=entry.model,
                    prompt_version=entry.prompt_version,
                    input_tokens=entry.input_tokens,
                    output_tokens=entry.output_tokens,
                    cache_read_tokens=entry.cache_read_tokens,
                    cost_microcents=entry.cost_microcents,
                    latency_ms=entry.latency_ms,
                    status=entry.status,
                    job_id=entry.job_id,
                    created_at=entry.created_at,
                )
            )


@dataclass
class MemoryLedger:
    """An in-process ledger for runs with no database (the eval runner).

    ``on_record`` sees each entry as it is written, before the caller reads the
    result; the eval runner charges its cost cap there.
    """

    clock: Clock = _utc_now
    on_record: Callable[[LedgerEntry], None] | None = None
    entries: list[LedgerEntry] = field(default_factory=list)

    def spent_today(self, user_id: uuid.UUID) -> int:
        start = _day_start(self.clock())
        return sum(
            entry.cost_microcents
            for entry in self.entries
            if entry.user_id == user_id and entry.created_at >= start
        )

    def record(self, entry: LedgerEntry) -> None:
        self.entries.append(entry)
        if self.on_record is not None:
            self.on_record(entry)


# ---------------------------------------------------------------- the gateway


class Gateway(ABC):
    """Budget, validation and ledger; subclasses supply the model call."""

    def __init__(
        self,
        settings: Settings,
        *,
        bind: Engine | Connection | None = None,
        clock: Clock = _utc_now,
        ledger: Ledger | None = None,
    ) -> None:
        self._settings = settings
        self._clock = clock
        self._ledger: Ledger = ledger if ledger is not None else DbLedger(bind=bind, clock=clock)

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

    def extract_pay_stub(
        self,
        user_id: uuid.UUID,
        pages: Sequence[ModelPage],
        *,
        job_id: uuid.UUID | None = None,
    ) -> PayStubExtraction:
        """Read a pay stub from redacted pages (spec 005)."""
        prompt = load_prompt(*EXTRACT_PAY_STUB_PROMPT)
        return self._call(
            prompt,
            PayStubExtraction,
            user_id=user_id,
            job_id=job_id,
            content=self._pages(pages),
        )

    def extract_benefits(
        self,
        user_id: uuid.UUID,
        pages: Sequence[ModelPage],
        *,
        job_id: uuid.UUID | None = None,
    ) -> BenefitsSummaryExtraction:
        """Read the plans, the 401(k) match and vesting of a benefits summary from
        redacted pages (specs 005 and 013)."""
        prompt = load_prompt(*EXTRACT_BENEFITS_PROMPT)
        return self._call(
            prompt,
            BenefitsSummaryExtraction,
            user_id=user_id,
            job_id=job_id,
            content=self._pages(pages),
        )

    def explain(
        self,
        user_id: uuid.UUID,
        context: ExplainContext,
        *,
        feedback: str | None = None,
    ) -> ExplanationDraft:
        """Draft an explanation of a decision from its facts (spec 008 rule 10).

        ``feedback`` is the verifier's account of an earlier draft's problems,
        sent with the one retry. The draft is unverified until ``verify`` says so.
        """
        payload: dict[str, Any] = {"context": context.model_dump(mode="json")}
        if feedback:
            payload["feedback"] = feedback
        prompt = load_prompt(*EXPLAIN_PROMPT)
        return self._call(
            prompt, ExplanationDraft, user_id=user_id, job_id=None, content=json.dumps(payload)
        )

    @staticmethod
    def _pages(pages: Sequence[ModelPage]) -> list[ContentBlockParam]:
        if not pages:
            raise ValueError("extraction needs at least one page; no pages were given")
        return page_content(pages)

    # The call ----------------------------------------------------------------

    def _call(
        self,
        prompt: Prompt,
        schema: type[Schema],
        *,
        user_id: uuid.UUID,
        job_id: uuid.UUID | None,
        content: Content,
    ) -> Schema:
        if prompt.schema is not schema:
            raise TypeError(f"{prompt.version} declares {prompt.schema.__name__}, not {schema}")
        model = self._model_for(prompt.purpose)
        self._check_model(model)

        def record(status: LlmStatus, usage: Usage, started: float | None) -> None:
            latency = 0 if started is None else round((time.monotonic() - started) * 1000)
            self._ledger.record(
                LedgerEntry(
                    user_id=user_id,
                    job_id=job_id,
                    purpose=prompt.purpose,
                    model=model,
                    prompt_version=prompt.version,
                    status=status,
                    input_tokens=usage.input_tokens + usage.cache_write_tokens,
                    output_tokens=usage.output_tokens,
                    cache_read_tokens=usage.cache_read_tokens,
                    cost_microcents=self._cost(model, usage),
                    latency_ms=latency,
                    created_at=self._clock(),
                )
            )
            log.info(
                "llm call %s %s status=%s latency_ms=%d",
                prompt.version,
                model,
                status.value,
                latency,
            )

        if (
            self._ledger.spent_today(user_id)
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
    def _send(self, prompt: Prompt, model: str, content: Content) -> Reply:
        """Make the model call. Raise ``LLMUnavailable`` or ``LLMError`` on failure."""


class LLMGateway(Gateway):
    """Calls the Anthropic Messages API."""

    def __init__(
        self,
        settings: Settings,
        *,
        bind: Engine | Connection | None = None,
        clock: Clock = _utc_now,
        ledger: Ledger | None = None,
        http_client: httpx2.Client | None = None,
        max_retries: int = 2,
    ) -> None:
        super().__init__(settings, bind=bind, clock=clock, ledger=ledger)
        if settings.anthropic_api_key is None:
            raise LLMNotConfigured("ANTHROPIC_API_KEY must be set unless LLM_FAKE=true")
        self._client = anthropic.Anthropic(
            api_key=settings.anthropic_api_key.get_secret_value(),
            max_retries=max_retries,
            timeout=REQUEST_TIMEOUT_SECONDS,
            http_client=http_client,
        )

    def _send(self, prompt: Prompt, model: str, content: Content) -> Reply:
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
        ledger: Ledger | None = None,
        fixtures: Path = FAKE_FIXTURES,
    ) -> None:
        super().__init__(settings, bind=bind, clock=clock, ledger=ledger)
        self._fixtures = fixtures

    def _model_for(self, purpose: LlmPurpose) -> str:
        return FAKE_MODEL

    def _check_model(self, model: str) -> None:
        return None

    def _cost(self, model: str, usage: Usage) -> int:
        return 0

    def _send(self, prompt: Prompt, model: str, content: Content) -> Reply:
        if prompt.schema is CategoryBatch and isinstance(content, str):
            text = self._categorize(content)
        elif prompt.schema is PayStubExtraction:
            text = self._fixture_text("extract_pay_stub.json")
        elif prompt.schema is BenefitsSummaryExtraction:
            text = self._fixture_text("extract_benefits.json")
        elif prompt.schema is ExplanationDraft and isinstance(content, str):
            text = self._explain(content)
        else:
            raise LLMError(f"FakeGateway has no answers for {prompt.version}")
        return Reply(stop_reason="end_turn", text=text, usage=Usage())

    def _categorize(self, content: str) -> str:
        items = json.loads(content)["items"]
        answers = [
            CategoryAssignment.model_validate(
                {"id": item["id"], **self._categories.get(item["merchant"], _fake_default())}
            )
            for item in items
        ]
        return CategoryBatch(items=answers).model_dump_json()

    @staticmethod
    def _explain(content: str) -> str:
        """A draft that states the first facts as given and cites the first
        allowed key, so it passes verification (spec 008 rule 10)."""
        context = ExplainContext.model_validate(json.loads(content)["context"])
        facts = context.facts[:FAKE_EXPLAIN_FACTS]
        draft = ExplanationDraft(
            concept="Your employer adds money to your 401(k) when you contribute.",
            text=" ".join(f"{fact.label}: {fact.value}." for fact in facts),
            numbers=[NumberClaim(value=fact.value, label=fact.label) for fact in facts],
            what_ifs=[],
            citation_keys=[context.citations[0].key] if context.citations else [],
        )
        return draft.model_dump_json()

    def _fixture_text(self, name: str) -> str:
        path = self._fixtures / name
        try:
            return path.read_text(encoding="utf-8")
        except FileNotFoundError:
            raise LLMError(f"FakeGateway: {path} is missing") from None

    @cached_property
    def _categories(self) -> Mapping[str, Mapping[str, Any]]:
        path = self._fixtures / "categorize.json"
        try:
            data: dict[str, dict[str, Any]] = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            log.warning("FakeGateway: %s is missing; every merchant is 'other'", path)
            return {}
        return data


ScriptStep = Reply | LLMError | None
REFUSAL_REPLY = Reply(stop_reason="refusal", text=None, usage=Usage())


def reply_with(answer: BaseModel) -> Reply:
    """A model reply whose text is ``answer`` as JSON."""
    return Reply(stop_reason="end_turn", text=answer.model_dump_json(), usage=Usage())


class ScriptedGateway(FakeGateway):
    """A ``FakeGateway`` that answers each call with the next step of a script.

    A ``Reply`` is returned as the model's reply (so refusals and bad JSON go
    through the real branches), an ``LLMError`` is raised as the API's failure,
    and ``None`` gives ``FakeGateway``'s own answer. For flow tests and the
    ``explain-smoke`` eval; ``contents`` keeps what each call sent.
    """

    def __init__(self, settings: Settings, *, script: Sequence[ScriptStep], **kwargs: Any) -> None:
        super().__init__(settings, **kwargs)
        self._script = list(script)
        self.contents: list[Content] = []

    def _send(self, prompt: Prompt, model: str, content: Content) -> Reply:
        self.contents.append(content)
        if not self._script:
            raise LLMError(f"ScriptedGateway: the script is exhausted at {prompt.version}")
        step = self._script.pop(0)
        if isinstance(step, LLMError):
            raise step
        if step is None:
            return super()._send(prompt, model, content)
        return step


def _fake_default() -> dict[str, Any]:
    category, confidence = FAKE_DEFAULT
    return {"category": category, "confidence": confidence}


def get_gateway(settings: Settings, *, bind: Engine | Connection | None = None) -> Gateway:
    """``FakeGateway`` when ``LLM_FAKE`` is on, otherwise the real one."""
    if settings.llm_fake:
        return FakeGateway(settings, bind=bind)
    return LLMGateway(settings, bind=bind)
