"""Background worker: ``python -m jobs.worker``.

Placeholder until M1 brings the Postgres job queue. It logs that it is not
implemented and then idles until SIGTERM or SIGINT, exiting 0. Idling rather
than exiting keeps ``make dev`` running (honcho stops every process when one
exits) and keeps Render from restart-looping the worker service.
"""

from __future__ import annotations

import logging
import signal
import threading

from app.logs import configure_logging

logger = logging.getLogger("jobs.worker")


def run(stop: threading.Event) -> int:
    logger.warning("jobs.worker is not implemented yet (job queue arrives in M1); idling")
    stop.wait()
    logger.info("worker stopped")
    return 0


def main() -> int:
    configure_logging()
    stop = threading.Event()
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_: stop.set())
    return run(stop)


if __name__ == "__main__":
    raise SystemExit(main())
