"""Which handler runs each job kind."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from db.enums import JobKind
from jobs.context import JobContext
from jobs.errors import UnknownJobKind

Handler = Callable[[JobContext], Mapping[str, Any]]


def default_handlers() -> dict[JobKind, Handler]:
    from jobs import scheduler
    from jobs.handlers import recurring

    return {
        JobKind.RECURRING_DETECT: recurring.detect,
        JobKind.SCHEDULE_TICK: scheduler.run_tick,
    }


def handler_for(handlers: Mapping[JobKind, Handler], kind: JobKind) -> Handler:
    try:
        return handlers[kind]
    except KeyError:
        raise UnknownJobKind(f"no handler for job kind {kind.value}") from None
