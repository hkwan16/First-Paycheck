"""`python -m app.serve` runs the API and the job worker as one Render Free service.

Render's free web tier has no background workers and no pre-deploy command, so
one container supervises both processes: it forwards SIGTERM to them, waits for
both to exit, and if either dies on its own it stops the other and exits
non-zero so Render restarts the service.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from app import serve

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


def test_commands_come_from_the_port_and_module_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PORT", "10000")
    commands = serve.default_commands()
    assert commands["api"][:2] == ["uvicorn", "app.main:app"]
    assert "10000" in commands["api"]
    assert "--workers" in commands["api"]
    assert commands["worker"] == [sys.executable, "-m", "jobs.worker"]


def test_main_forwards_sigterm_end_to_end(tmp_path: Path) -> None:
    """The real entry point, as Render runs it, with stand-in children."""
    script = tmp_path / "stub.py"
    script.write_text(
        "import signal, sys, time\n"
        "signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))\n"
        "time.sleep(30)\n"
    )
    env = {**os.environ, "SERVE_COMMANDS_JSON": serve.commands_json(
        {"api": [sys.executable, str(script)], "worker": [sys.executable, str(script)]}
    )}
    proc = subprocess.Popen([sys.executable, "-m", "app.serve"], env=env, cwd=Path(serve.__file__).parents[1])
    time.sleep(1.0)
    proc.send_signal(signal.SIGTERM)
    assert proc.wait(timeout=10) == 0
