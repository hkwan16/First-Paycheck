"""Background worker: ``python -m jobs.worker`` (spec 002 rule 35).

The loop claims one due job at a time from the Postgres queue, runs its
handler (which opens sessions as the job's user, under RLS), writes a
heartbeat every 30 s while the handler runs, and records success or a failed
attempt. It polls every second when idle. SIGTERM or SIGINT lets the current
job finish, then the process exits 0. On startup it makes sure the
scheduler's ``schedule.tick`` chain exists.
"""

from __future__ import annotations

import logging
import signal
import threading
import time
import uuid
from collections.abc import Mapping

from sqlalchemy import Connection, Engine

from app.config import get_settings
from app.logs import configure_logging
from db.enums import JobKind
from jobs import queue, scheduler
from jobs.context import JobContext, Services
from jobs.queue import QueueBind
from jobs.registry import Handler, default_handlers, handler_for
from jobs.services import default_services

logger = logging.getLogger("jobs.worker")

HEARTBEAT_SECONDS = 30.0
POLL_SECONDS = 1.0


class _Heartbeat:
    """Touches ``heartbeat_at`` on its own thread while a handler runs.

    Only used with an Engine: a single Connection (tests) cannot be shared
    across threads.
    """

    def __init__(self, job_id: uuid.UUID, bind: QueueBind | None, interval: float) -> None:
        self._job_id = job_id
        self._bind = bind
        self._interval = interval
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name=f"heartbeat-{job_id}", daemon=True)

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                queue.heartbeat(self._job_id, bind=self._bind)
            except Exception:
                logger.exception("heartbeat failed for job %s", self._job_id)

    def __enter__(self) -> _Heartbeat:
        if not isinstance(self._bind, Connection):
            self._thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self._stop.set()
        if self._thread.is_alive():
            self._thread.join()


class Worker:
    def __init__(
        self,
        *,
        handlers: Mapping[JobKind, Handler] | None = None,
        services: Services | None = None,
        queue_bind: QueueBind | None = None,
        user_bind: Engine | Connection | None = None,
        heartbeat_seconds: float = HEARTBEAT_SECONDS,
    ) -> None:
        self._handlers = dict(handlers) if handlers is not None else default_handlers()
        self._services = services if services is not None else Services()
        self._queue_bind = queue_bind
        self._user_bind = user_bind
        self._heartbeat_seconds = heartbeat_seconds

    def run_once(self) -> bool:
        """Run one due job. False when there was none."""
        job = queue.dequeue(bind=self._queue_bind)
        if job is None:
            return False
        started = time.monotonic()
        ctx = JobContext(
            job=job,
            services=self._services,
            queue_bind=self._queue_bind,
            user_bind=self._user_bind,
        )
        try:
            handler = handler_for(self._handlers, job.kind)
            with _Heartbeat(job.id, self._queue_bind, self._heartbeat_seconds):
                result = handler(ctx)
        except Exception as exc:
            status = queue.fail(job, exc, bind=self._queue_bind)
            logger.warning(
                "job %s %s attempt %d failed (%s): %s",
                job.id,
                job.kind.value,
                job.attempts,
                status.value if status else "no longer running",
                queue.error_text(exc),
            )
            return True
        queue.complete(job, result, bind=self._queue_bind)
        logger.info(
            "job %s %s succeeded in %d ms",
            job.id,
            job.kind.value,
            (time.monotonic() - started) * 1000,
        )
        return True

    def run(self, stop: threading.Event, *, poll_seconds: float = POLL_SECONDS) -> int:
        scheduler.ensure_tick(bind=self._queue_bind)
        logger.info("worker started")
        while not stop.is_set():
            try:
                worked = self.run_once()
            except Exception:
                # The queue itself failed (database unreachable): back off.
                logger.exception("worker loop error")
                worked = False
            if not worked:
                stop.wait(poll_seconds)
        logger.info("worker stopped")
        return 0


def main() -> int:
    configure_logging()
    stop = threading.Event()
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_: stop.set())
    return Worker(services=default_services(get_settings())).run(stop)


if __name__ == "__main__":
    raise SystemExit(main())
