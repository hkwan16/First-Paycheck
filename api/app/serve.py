"""Run the API and the job worker in one container.

Render's free web tier offers no background workers and no pre-deploy command,
so the single free web service runs both processes under this supervisor:

    python -m app.serve

It starts the API (``python -m app.serve api``, uvicorn) and
``python -m jobs.worker`` as children, forwards SIGTERM and SIGINT to both,
and waits for them. If either child exits on its own the
other is terminated and the supervisor exits 1, so Render restarts the service
instead of running half of it. Migrations run from CI before the deploy hook
fires (see .github/workflows/deploy.yml), not here.

When ``KEEPALIVE_URL`` is set (Render only) the supervisor also runs
``app.keepalive.Pinger`` on a thread: a request to the service's own public
URL every 10 minutes, so Render Free never sees the instance idle while it is
up (issue 197). The GitHub cron remains the restarter for an instance that
did sleep.

``python -m app.serve api`` runs uvicorn in-process with the logging config
from ``app.logs``, so uvicorn's own lines are JSON like the app's and its
access log gives way to ``app.request``'s one line per request.

``SERVE_COMMANDS_JSON`` overrides the child commands; tests use it.
"""

from __future__ import annotations

import json
import logging
import os
import signal
import subprocess
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from typing import Any

import uvicorn

from app.config import get_settings
from app.keepalive import Pinger, pinger_for
from app.logs import configure_logging, logging_config

log = logging.getLogger(__name__)

POLL_SECONDS = 0.2
GRACE_SECONDS = 25.0  # Render sends SIGKILL about 30 s after SIGTERM.


def default_commands() -> dict[str, list[str]]:
    return {
        "api": [sys.executable, "-m", "app.serve", "api"],
        "worker": [sys.executable, "-m", "jobs.worker"],
    }


def api_options() -> dict[str, Any]:
    """uvicorn settings for the API child, from Render's environment."""
    return {
        "host": "0.0.0.0",  # noqa: S104 (the container must listen on all interfaces)
        "port": int(os.environ.get("PORT", "8000")),
        "workers": int(os.environ.get("WEB_CONCURRENCY", "1")),
        "proxy_headers": True,
        "forwarded_allow_ips": "*",
        "access_log": False,
        "log_config": logging_config(),
    }


def run_api() -> None:
    uvicorn.run("app.main:app", **api_options())


def commands_json(commands: Mapping[str, list[str]]) -> str:
    return json.dumps(dict(commands))


def commands_from_env() -> dict[str, list[str]]:
    raw = os.environ.get("SERVE_COMMANDS_JSON")
    if not raw:
        return default_commands()
    parsed = json.loads(raw)
    return {str(name): [str(part) for part in argv] for name, argv in parsed.items()}


class Supervisor:
    def __init__(self, commands: Mapping[str, list[str]], *, pinger: Pinger | None = None) -> None:
        self.commands = dict(commands)
        self.pinger = pinger
        self.processes: dict[str, subprocess.Popen[bytes]] = {}

    def start(self) -> None:
        for name, argv in self.commands.items():
            # argv comes from this module or the operator (SERVE_COMMANDS_JSON), never from users.
            self.processes[name] = subprocess.Popen(argv)  # noqa: S603
            log.info("child started", extra={"child": name, "pid": self.processes[name].pid})

    def _signal_all(self, signum: int) -> None:
        for name, proc in self.processes.items():
            if proc.poll() is None:
                try:
                    proc.send_signal(signum)
                except ProcessLookupError:
                    log.info("child already gone", extra={"child": name})

    def _wait_all(self, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        for proc in self.processes.values():
            remaining = max(0.0, deadline - time.monotonic())
            try:
                proc.wait(timeout=remaining)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()

    def run(self, stop_requested: Callable[[float], bool] | None = None) -> int:
        """Supervise until a stop is requested or a child exits. Returns the exit code."""
        self.start()
        if self.pinger is not None:
            self.pinger.start()
        try:
            return self._wait_for_exit(stop_requested)
        finally:
            if self.pinger is not None:
                self.pinger.stop()

    def _wait_for_exit(self, stop_requested: Callable[[float], bool] | None) -> int:
        while True:
            if stop_requested is not None and stop_requested(time.monotonic()):
                log.info("stop requested, terminating children")
                self._signal_all(signal.SIGTERM)
                self._wait_all(GRACE_SECONDS)
                return 0
            for name, proc in self.processes.items():
                code = proc.poll()
                if code is not None:
                    log.error(
                        "child exited, stopping the rest", extra={"child": name, "code": code}
                    )
                    self._signal_all(signal.SIGTERM)
                    self._wait_all(GRACE_SECONDS)
                    return 1
            time.sleep(POLL_SECONDS)


def supervisor_from_env() -> Supervisor:
    return Supervisor(commands_from_env(), pinger=pinger_for(get_settings()))


def supervise() -> int:
    stop = {"requested": False}

    def request_stop(*_: object) -> None:
        stop["requested"] = True

    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, request_stop)
    return supervisor_from_env().run(stop_requested=lambda _: stop["requested"])


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args == ["api"]:
        run_api()
        return 0
    if args:
        sys.stderr.write("usage: python -m app.serve [api]\n")
        return 2
    configure_logging()
    return supervise()


if __name__ == "__main__":
    raise SystemExit(main())
