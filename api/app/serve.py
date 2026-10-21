"""Run the API and the job worker in one container.

Render's free web tier offers no background workers and no pre-deploy command,
so the single free web service runs both processes under this supervisor:

    python -m app.serve

It starts uvicorn and ``python -m jobs.worker`` as children, forwards SIGTERM
and SIGINT to both, and waits for them. If either child exits on its own the
other is terminated and the supervisor exits 1, so Render restarts the service
instead of running half of it. Migrations run from CI before the deploy hook
fires (see .github/workflows/deploy.yml), not here.

``SERVE_COMMANDS_JSON`` overrides the child commands; tests use it.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from collections.abc import Callable, Mapping

POLL_SECONDS = 0.2
GRACE_SECONDS = 25.0  # Render sends SIGKILL about 30 s after SIGTERM.


def default_commands() -> dict[str, list[str]]:
    port = os.environ.get("PORT", "8000")
    workers = os.environ.get("WEB_CONCURRENCY", "1")
    return {
        "api": [
            "uvicorn",
            "app.main:app",
            "--host",
            "0.0.0.0",
            "--port",
            port,
            "--workers",
            workers,
            "--proxy-headers",
            "--forwarded-allow-ips",
            "*",
        ],
        "worker": [sys.executable, "-m", "jobs.worker"],
    }


def commands_json(commands: Mapping[str, list[str]]) -> str:
    return json.dumps(dict(commands))


def commands_from_env() -> dict[str, list[str]]:
    raw = os.environ.get("SERVE_COMMANDS_JSON")
    if not raw:
        return default_commands()
    parsed = json.loads(raw)
    return {str(name): [str(part) for part in argv] for name, argv in parsed.items()}


class Supervisor:
    def __init__(self, commands: Mapping[str, list[str]]) -> None:
        self.commands = dict(commands)
        self.processes: dict[str, subprocess.Popen[bytes]] = {}

    def start(self) -> None:
        for name, argv in self.commands.items():
            self.processes[name] = subprocess.Popen(argv)
            print(f"serve: started {name} pid={self.processes[name].pid}", flush=True)

    def _signal_all(self, signum: int) -> None:
        for name, proc in self.processes.items():
            if proc.poll() is None:
                try:
                    proc.send_signal(signum)
                except ProcessLookupError:
                    print(f"serve: {name} already gone", flush=True)

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
        while True:
            if stop_requested is not None and stop_requested(time.monotonic()):
                print("serve: stop requested, terminating children", flush=True)
                self._signal_all(signal.SIGTERM)
                self._wait_all(GRACE_SECONDS)
                return 0
            for name, proc in self.processes.items():
                code = proc.poll()
                if code is not None:
                    print(f"serve: {name} exited with {code}, stopping the rest", flush=True)
                    self._signal_all(signal.SIGTERM)
                    self._wait_all(GRACE_SECONDS)
                    return 1
            time.sleep(POLL_SECONDS)


def main() -> int:
    stop = {"requested": False}

    def request_stop(*_: object) -> None:
        stop["requested"] = True

    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, request_stop)
    supervisor = Supervisor(commands_from_env())
    return supervisor.run(stop_requested=lambda _: stop["requested"])


if __name__ == "__main__":
    raise SystemExit(main())
