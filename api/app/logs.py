"""Process-wide logging for the API, the worker, the Render supervisor and CLIs.

Every process logs through one root handler on stderr. The line format is
JSON (one object per line: ``ts``, ``level``, ``logger``, ``message``, then
the record's fields) except on a developer's terminal (``APP_ENV=development``
and a TTY), where it is plain text. uvicorn's loggers propagate to the root,
so its lines share the format; its access log is off because
``app.request_log`` writes one line per request.

``log_context(**fields)`` adds fields to every line written inside its block,
including from threads started with a copy of the context (FastAPI's
threadpool): the request middleware binds ``request_id``, the worker binds the
job. Pass ids and counts only: never tokens, request bodies, document bytes or
extracted values.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import logging.config
import sys
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from types import MappingProxyType
from typing import Any, TextIO

from app.config import Settings, get_settings

__all__ = [
    "JsonFormatter",
    "TextFormatter",
    "configure_logging",
    "ensure_logging",
    "formatter_class",
    "log_context",
    "logging_config",
]

_context: ContextVar[Mapping[str, Any]] = ContextVar("log_context", default=MappingProxyType({}))
_CONTEXT_ATTRIBUTE = "_log_context"

# Attributes every LogRecord has, plus uvicorn's ANSI copy of its message.
_STANDARD_ATTRIBUTES = frozenset(vars(logging.makeLogRecord({}))) | {
    "message",
    "asctime",
    "color_message",
}


@contextmanager
def log_context(**fields: Any) -> Iterator[None]:
    """Add ``fields`` to every line logged inside the block."""
    token = _context.set({**_context.get(), **fields})
    try:
        yield
    finally:
        _context.reset(token)


class _ContextStamper:
    """A LogRecord factory that stamps each record with the context it was created in.

    At creation, not at formatting: a handler may format later, outside the
    block (pytest's ``caplog`` does). The fields live in one private attribute
    so a call's own ``extra`` never collides with them.
    """

    def __init__(self, previous: Callable[..., logging.LogRecord]) -> None:
        self._previous = previous

    def __call__(self, *args: Any, **kwargs: Any) -> logging.LogRecord:
        record = self._previous(*args, **kwargs)
        setattr(record, _CONTEXT_ATTRIBUTE, _context.get())
        return record


if not isinstance(logging.getLogRecordFactory(), _ContextStamper):
    logging.setLogRecordFactory(_ContextStamper(logging.getLogRecordFactory()))


def _fields(record: logging.LogRecord) -> dict[str, Any]:
    """The record's context, then its own extras (which win)."""
    fields = dict(getattr(record, _CONTEXT_ATTRIBUTE, {}))
    fields.update(
        (key, value)
        for key, value in vars(record).items()
        if key not in _STANDARD_ATTRIBUTES and not key.startswith("_")
    )
    return fields


class JsonFormatter(logging.Formatter):
    """One JSON object per line; tracebacks go in ``exc`` (newlines escaped)."""

    def format(self, record: logging.LogRecord) -> str:
        when = dt.datetime.fromtimestamp(record.created, dt.UTC)
        entry: dict[str, Any] = {
            "ts": when.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        entry.update(_fields(record))
        if record.exc_info:
            entry["exc"] = self.formatException(record.exc_info)
        if record.stack_info:
            entry["stack"] = self.formatStack(record.stack_info)
        return json.dumps(entry, default=str, separators=(",", ":"))


class TextFormatter(logging.Formatter):
    """``HH:MM:SS LEVEL logger message key=value ...`` for a terminal."""

    def __init__(self) -> None:
        super().__init__(datefmt="%H:%M:%S")

    def format(self, record: logging.LogRecord) -> str:
        line = (
            f"{self.formatTime(record, self.datefmt)} {record.levelname} {record.name}"
            f" {record.getMessage()}"
        )
        fields = " ".join(f"{key}={value}" for key, value in _fields(record).items())
        if fields:
            line = f"{line} {fields}"
        if record.exc_info:
            line = f"{line}\n{self.formatException(record.exc_info)}"
        if record.stack_info:
            line = f"{line}\n{self.formatStack(record.stack_info)}"
        return line


def formatter_class(settings: Settings, stream: TextIO) -> type[logging.Formatter]:
    """Plain text on a developer's terminal, JSON everywhere else."""
    if settings.app_env == "development" and stream.isatty():
        return TextFormatter
    return JsonFormatter


def logging_config(settings: Settings | None = None) -> dict[str, Any]:
    """A ``logging.config.dictConfig`` dict; uvicorn takes it as ``log_config``."""
    settings = settings or get_settings()
    level = settings.log_level.upper()
    return {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {"app": {"()": formatter_class(settings, sys.stderr)}},
        "handlers": {
            "stderr": {
                "class": "logging.StreamHandler",
                "stream": "ext://sys.stderr",
                "formatter": "app",
            }
        },
        "root": {"level": level, "handlers": ["stderr"]},
        "loggers": {
            "uvicorn": {"level": level, "handlers": [], "propagate": True},
            "uvicorn.error": {"level": level, "handlers": [], "propagate": True},
            # app.request writes the request line; WARNING keeps uvicorn's quiet.
            "uvicorn.access": {"level": "WARNING", "handlers": [], "propagate": False},
        },
    }


def configure_logging(settings: Settings | None = None) -> None:
    """Install the process's logging; safe to call again."""
    logging.config.dictConfig(logging_config(settings))


def ensure_logging() -> None:
    """Configure logging unless the process already has (``app.serve`` passes
    the config to uvicorn; a bare ``uvicorn app.main:app`` does not)."""
    if not logging.getLogger().handlers:
        configure_logging()
