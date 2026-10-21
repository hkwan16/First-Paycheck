"""Process entrypoints used by Render and Procfile.dev: the worker and the seed loader."""

from __future__ import annotations

import logging
import signal
import subprocess
import sys
import threading
import time

import pytest

from app.config import REPO_ROOT
from db.seed import load
from jobs import worker

API = REPO_ROOT / "api"


def test_worker_placeholder_says_it_is_not_implemented(caplog: pytest.LogCaptureFixture) -> None:
    stop = threading.Event()
    stop.set()
    with caplog.at_level(logging.INFO):
        assert worker.run(stop) == 0
    assert "not implemented" in caplog.text


def test_worker_process_exits_cleanly_on_sigterm() -> None:
    process = subprocess.Popen(
        [sys.executable, "-m", "jobs.worker"],
        cwd=API,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        deadline = time.monotonic() + 10
        assert process.stderr is not None
        line = process.stderr.readline()
        while "not implemented" not in line and time.monotonic() < deadline:
            line = process.stderr.readline()
        assert "not implemented" in line
        process.send_signal(signal.SIGTERM)
        assert process.wait(timeout=10) == 0
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        if process.stderr is not None:
            process.stderr.close()


def test_seed_loader_is_a_logged_no_op(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.INFO):
        assert load.load() == 0
    assert "no seeds yet" in caplog.text


def test_seed_loader_module_runs() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "db.seed.load"], cwd=API, capture_output=True, text=True, check=False
    )
    assert result.returncode == 0
    assert "no seeds yet" in result.stderr
