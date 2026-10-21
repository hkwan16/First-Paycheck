"""What a job handler receives: the claimed job, sessions and services."""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from sqlalchemy import Connection, Engine
from sqlalchemy.orm import Session

from app.db import user_session_for
from jobs import queue
from jobs.queue import ClaimedJob, QueueBind

if TYPE_CHECKING:
    from jobs.handlers.ingest_extract import DocumentExtractor
    from sync.categorize import CategoryLabeler
    from sync.pipeline import ProviderFactory


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


@dataclass(frozen=True)
class Services:
    """Collaborators built once per worker process and shared by every job.

    Tests pass fakes; ``jobs.services.default_services`` builds the real ones.
    """

    provider_for: ProviderFactory | None = None
    labeler: CategoryLabeler | None = None
    extractor: DocumentExtractor | None = None
    # The jobs' clock (UTC); tests pass a fixed one.
    clock: Callable[[], dt.datetime] = utc_now


@dataclass
class JobContext:
    job: ClaimedJob
    services: Services = field(default_factory=Services)
    # Privileged bind for queue bookkeeping; None means the privileged engine.
    queue_bind: QueueBind | None = None
    # What user sessions bind to; None means the app_api engine.
    user_bind: Engine | Connection | None = None

    @property
    def user_id(self) -> uuid.UUID:
        if self.job.user_id is None:
            raise RuntimeError(f"{self.job.kind} is a system job and has no user")
        return self.job.user_id

    def user_session(self) -> AbstractContextManager[Session]:
        """A session as the job's user, under RLS (one transaction per block)."""
        return user_session_for(self.user_id, bind=self.user_bind)

    def progress(self, percent: int) -> None:
        """Report progress; call it between, not inside, user-session blocks."""
        queue.set_progress(self.job.id, percent, bind=self.queue_bind)
