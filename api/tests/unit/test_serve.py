"""`python -m app.serve` runs the API and the job worker as one Render Free service.

Render's free web tier has no background workers and no pre-deploy command, so
one container supervises both processes: it forwards SIGTERM to them, waits for
both to exit, and if either dies on its own it stops the other and exits
non-zero so Render restarts the service.
"""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from app import logs, serve

# Child commands that behave like the real processes: run until SIGTERM, exit 0.
SLEEP_UNTIL_TERM = [
    sys.executable,
    "-c",
    "import signal, sys, time\n"
    "signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))\n"
    "time.sleep(30)\n",
]
EXIT_NOW = [sys.executable, "-c", "import sys; sys.exit(3)"]


def _run(children: dict[str, list[str]], *, send_term_after: float | None) -> int:
    supervisor = serve.Supervisor(children)
    if send_term_after is None:
        return supervisor.run()
    started = time.monotonic()

    def deadline(_: float) -> bool:
        return time.monotonic() - started >= send_term_after

    return supervisor.run(stop_requested=deadline)


def test_sigterm_stops_both_children_and_exits_zero() -> None:
    code = _run({"api": SLEEP_UNTIL_TERM, "worker": SLEEP_UNTIL_TERM}, send_term_after=0.3)
    assert code == 0


def test_a_child_dying_stops_the_other_and_exits_nonzero() -> None:
    supervisor = serve.Supervisor({"api": SLEEP_UNTIL_TERM, "worker": EXIT_NOW})
    code = supervisor.run()
    assert code == 1
    assert all(proc.returncode is not None for proc in supervisor.processes.values())


def test_children_are_the_api_server_and_the_worker() -> None:
    commands = serve.default_commands()
    assert commands["api"] == [sys.executable, "-m", "app.serve", "api"]
    assert commands["worker"] == [sys.executable, "-m", "jobs.worker"]


def test_the_api_runs_uvicorn_with_the_process_logging_config(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PORT", "10000")
    monkeypatch.setenv("WEB_CONCURRENCY", "2")
    calls: list[tuple[tuple[object, ...], dict[str, object]]] = []
    monkeypatch.setattr(serve.uvicorn, "run", lambda *a, **k: calls.append((a, k)))
    assert serve.main(["api"]) == 0
    [(args, kwargs)] = calls
    assert args == ("app.main:app",)
    assert kwargs["port"] == 10000
    assert kwargs["workers"] == 2
    assert kwargs["proxy_headers"] is True
    assert kwargs["forwarded_allow_ips"] == "*"
    # app.request writes the one line per request; uvicorn's access log would repeat it.
    assert kwargs["access_log"] is False
    assert kwargs["log_config"] == logs.logging_config()


def test_an_unknown_role_is_a_usage_error() -> None:
    assert serve.main(["web"]) == 2


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port: int = sock.getsockname()[1]
        return port


def probe(port: int, request_id: str) -> str | None:
    """GET /health until the server answers; the X-Request-Id it returned."""
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/health", headers={"X-Request-Id": request_id}
    )
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(request, timeout=1) as response:  # noqa: S310 (fixed local URL)
                return response.headers.get("X-Request-Id")
        except urllib.error.HTTPError as error:
            # Without a database /health is 503; the request was still served.
            return error.headers.get("X-Request-Id")
        except OSError:
            time.sleep(0.1)
    return None


def test_the_api_process_writes_json_request_lines(tmp_path: Path) -> None:
    """``python -m app.serve api`` as Render runs it: every line on stderr is JSON."""
    port = free_port()
    env = {**os.environ, "PORT": str(port), "WEB_CONCURRENCY": "1"}
    api_dir = Path(serve.__file__).parents[1]
    err_path = tmp_path / "stderr.log"
    with err_path.open("w") as err:
        proc = subprocess.Popen(
            [sys.executable, "-m", "app.serve", "api"], env=env, cwd=api_dir, stderr=err
        )
        try:
            assert probe(port, "e2e-probe") == "e2e-probe"
        finally:
            proc.send_signal(signal.SIGTERM)
            proc.wait(timeout=15)
    lines = [json.loads(line) for line in err_path.read_text().splitlines() if line.strip()]
    assert any(line["logger"].startswith("uvicorn") for line in lines)
    [request] = [line for line in lines if line["logger"] == "app.request"]
    assert (request["method"], request["path"], request["request_id"]) == (
        "GET",
        "/health",
        "e2e-probe",
    )


def test_main_forwards_sigterm_end_to_end(tmp_path: Path) -> None:
    """The real entry point, as Render runs it, with stand-in children."""
    script = tmp_path / "stub.py"
    script.write_text(
        "import signal, sys, time\n"
        "signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))\n"
        "time.sleep(30)\n"
    )
    env = {
        **os.environ,
        "SERVE_COMMANDS_JSON": serve.commands_json(
            {"api": [sys.executable, str(script)], "worker": [sys.executable, str(script)]}
        ),
    }
    api_dir = Path(serve.__file__).parents[1]
    proc = subprocess.Popen([sys.executable, "-m", "app.serve"], env=env, cwd=api_dir)
    time.sleep(1.0)
    proc.send_signal(signal.SIGTERM)
    assert proc.wait(timeout=10) == 0
