"""Keep the Render Free instance warm by requesting its own public URL.

Render Free spins a web service down after 15 minutes without an inbound
request and takes 20 to 60 seconds to come back. The GitHub Actions cron in
``.github/workflows/keepalive.yml`` asks for a ping every 10 minutes, but
GitHub runs schedules when it has capacity: three runs in eight hours on
November 1, two to four a day since (issue 197). A request to the service's
own public URL arrives through Render's proxy like a visitor's, so while the
instance is up it can keep itself up. ``app.serve`` runs a ``Pinger`` on a
thread beside the API and the worker when ``KEEPALIVE_URL`` is set (blank,
as everywhere but Render, means no self-ping); the cron stays as the
restarter for an instance that did sleep.

Plain ``http.client``: the API has no HTTP client dependency of its own and a
status line is all a ping needs. The first ping waits one interval, so a
deploy whose API is still starting is not reported as a failure.
"""

from __future__ import annotations

import http.client
import logging
import threading
import time
from collections.abc import Callable
from urllib.parse import urlsplit, urlunsplit

from app.config import Settings

log = logging.getLogger(__name__)

INTERVAL_SECONDS = 600.0  # well inside Render's 15 idle minutes
TIMEOUT_SECONDS = 60.0  # an instance that did sleep answers within about a minute
STOP_GRACE_SECONDS = 1.0  # a request in flight is abandoned; the process is exiting

Fetch = Callable[[str, float], int]
"""``fetch(url, timeout)`` returns the HTTP status; connection errors raise."""


def fetch_status(url: str, timeout: float) -> int:
    """GET ``url`` and return its status code. The body is not read."""
    parts = urlsplit(url)
    connection_class = (
        http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    )
    connection = connection_class(parts.netloc, timeout=timeout)
    try:
        target = urlunsplit(("", "", parts.path or "/", parts.query, ""))
        connection.request("GET", target, headers={"User-Agent": "first-paycheck-keepalive"})
        return connection.getresponse().status
    finally:
        connection.close()


class Pinger:
    """Requests ``url`` every ``interval`` seconds on a daemon thread until stopped."""

    def __init__(
        self,
        url: str,
        *,
        interval: float = INTERVAL_SECONDS,
        timeout: float = TIMEOUT_SECONDS,
        fetch: Fetch = fetch_status,
    ) -> None:
        self.url = url
        self._interval = interval
        self._timeout = timeout
        self._fetch = fetch
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="keepalive", daemon=True)

    def ping(self) -> None:
        """One request; a failure is a warning, never an exception."""
        started = time.monotonic()
        try:
            status = self._fetch(self.url, self._timeout)
        except (OSError, http.client.HTTPException) as exc:
            log.warning(
                "keepalive ping failed",
                extra={
                    "error": f"{type(exc).__name__}: {exc}",
                    "duration_ms": _elapsed_ms(started),
                },
            )
            return
        log.log(
            logging.INFO if status < 400 else logging.WARNING,
            "keepalive ping",
            extra={"status": status, "duration_ms": _elapsed_ms(started)},
        )

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            self.ping()

    def start(self) -> None:
        self._thread.start()
        log.info("keepalive started", extra={"interval_seconds": self._interval})

    def stop(self) -> None:
        self._stop.set()
        if self._thread.is_alive():
            self._thread.join(timeout=STOP_GRACE_SECONDS)


def pinger_for(settings: Settings) -> Pinger | None:
    """The self-pinger for this deployment, or None when ``KEEPALIVE_URL`` is blank."""
    if settings.keepalive_url is None:
        return None
    return Pinger(settings.keepalive_url)


def _elapsed_ms(started: float) -> float:
    return round((time.monotonic() - started) * 1000, 1)
