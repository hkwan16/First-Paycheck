"""The deployed API keeps its own Render Free instance warm (issue 197).

GitHub runs the keep-alive cron when it has capacity, two to four times a day
instead of every 10 minutes, so the instance slept between runs. With
``KEEPALIVE_URL`` set, ``app.serve`` requests the service's own public URL
every 10 minutes from a thread beside the API and the worker.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable, Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from app.config import Settings
from app.keepalive import Pinger, fetch_status, pinger_for
from tests.support.net import free_port

URL = "https://api.example/health"


class RecordingFetch:
    """A stand-in for the HTTP request: records each call, answers or raises."""

    def __init__(self, *, status: int = 200, error: Exception | None = None) -> None:
        self.calls: list[tuple[str, float]] = []
        self._status = status
        self._error = error

    def __call__(self, url: str, timeout: float) -> int:
        self.calls.append((url, timeout))
        if self._error is not None:
            raise self._error
        return self._status


def wait_until(condition: Callable[[], bool], *, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        assert time.monotonic() < deadline, "the pinger did not run in time"
        time.sleep(0.01)


def test_pings_the_url_on_its_interval_and_stops_cleanly() -> None:
    fetch = RecordingFetch()
    pinger = Pinger(URL, interval=0.02, timeout=3.0, fetch=fetch)
    pinger.start()
    wait_until(lambda: len(fetch.calls) >= 3)
    pinger.stop()
    seen = len(fetch.calls)
    time.sleep(0.1)
    assert len(fetch.calls) == seen
    assert fetch.calls[0] == (URL, 3.0)


def test_a_warm_answer_is_logged_with_its_status(caplog: pytest.LogCaptureFixture) -> None:
    pinger = Pinger(URL, fetch=RecordingFetch(status=200))
    with caplog.at_level(logging.INFO, logger="app.keepalive"):
        pinger.ping()
    [record] = caplog.records
    assert record.levelno == logging.INFO
    assert record.getMessage() == "keepalive ping"
    assert vars(record)["status"] == 200


def test_an_error_answer_is_a_warning(caplog: pytest.LogCaptureFixture) -> None:
    pinger = Pinger(URL, fetch=RecordingFetch(status=503))
    with caplog.at_level(logging.INFO, logger="app.keepalive"):
        pinger.ping()
    [record] = caplog.records
    assert record.levelno == logging.WARNING
    assert vars(record)["status"] == 503


def test_a_failed_request_is_a_warning_and_the_next_ping_still_runs(
    caplog: pytest.LogCaptureFixture,
) -> None:
    fetch = RecordingFetch(error=ConnectionRefusedError("connection refused"))
    pinger = Pinger(URL, interval=0.02, fetch=fetch)
    with caplog.at_level(logging.WARNING, logger="app.keepalive"):
        pinger.start()
        wait_until(lambda: len(fetch.calls) >= 2)
        pinger.stop()
    failures = [r for r in caplog.records if r.getMessage() == "keepalive ping failed"]
    assert failures
    assert "connection refused" in vars(failures[0])["error"]


def _recording_handler(paths: list[str]) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            paths.append(self.path)
            body = b'{"status":"ok"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_: object) -> None:
            """Keep the test output quiet."""

    return Handler


@pytest.fixture
def local_server() -> Iterator[tuple[str, list[str]]]:
    paths: list[str] = []
    server = HTTPServer(("127.0.0.1", 0), _recording_handler(paths))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", paths
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_fetch_status_requests_the_path_and_returns_the_status(
    local_server: tuple[str, list[str]],
) -> None:
    base, paths = local_server
    assert fetch_status(f"{base}/health?from=keepalive", 5.0) == 200
    assert paths == ["/health?from=keepalive"]


def test_fetch_status_raises_when_nothing_listens() -> None:
    with pytest.raises(ConnectionRefusedError):
        fetch_status(f"http://127.0.0.1:{free_port()}/health", 2.0)


def test_no_url_means_no_pinger(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("KEEPALIVE_URL", raising=False)
    assert pinger_for(Settings(_env_file=None)) is None


def test_the_pinger_takes_its_url_from_settings() -> None:
    pinger = pinger_for(Settings(_env_file=None, keepalive_url=URL))
    assert pinger is not None
    assert pinger.url == URL
