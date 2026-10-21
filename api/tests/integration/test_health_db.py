"""GET /health against the migrated test database."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Connection, Engine, text

from app.config import REPO_ROOT
from app.db import make_engine
from app.deps import get_db_bind, get_queue_bind
from app.main import create_app
from tests.support.database import head_revision, upgrade
from tests.support.net import free_port


def test_health_reports_the_migrated_revision(app: FastAPI) -> None:
    response = TestClient(app).get("/health")
    assert response.status_code == 200
    assert response.json()["alembic_revision"] == head_revision()


def test_health_uses_the_configured_engine(migrated_engine: Engine) -> None:
    # No dependency overrides: the app builds its own engines from DATABASE_URL
    # and DATABASE_URL_PRIVILEGED.
    response = TestClient(create_app()).get("/health")
    assert response.status_code == 200
    assert response.json()["alembic_revision"] == head_revision()
    assert response.json()["worker"] in {"ok", "stale"}


def test_health_reports_a_stale_worker_and_stays_200(
    app: FastAPI, db_connection: Connection
) -> None:
    db_connection.execute(text("DELETE FROM jobs"))
    response = TestClient(app).get("/health")
    assert response.status_code == 200
    assert response.json()["worker"] == "stale"


def test_health_reports_a_worker_that_just_ticked(app: FastAPI, db_connection: Connection) -> None:
    db_connection.execute(text("DELETE FROM jobs"))
    db_connection.execute(
        text(
            "INSERT INTO jobs (kind, status, finished_at)"
            " VALUES ('schedule.tick', 'succeeded', now())"
        )
    )
    assert TestClient(app).get("/health").json()["worker"] == "ok"


def test_the_deployed_process_reports_its_worker(
    scratch_database: tuple[str, Engine], tmp_path: Path
) -> None:
    """End to end as Render runs it: ``python -m app.serve`` starts the API and
    the worker; the worker's first tick turns /health's ``worker`` to ok."""
    url, _ = scratch_database
    upgrade(url, "head")
    port = free_port()
    env = {
        **os.environ,
        "DATABASE_URL": url,
        "DATABASE_URL_PRIVILEGED": url,
        "PORT": str(port),
        "WEB_CONCURRENCY": "1",
    }
    with (tmp_path / "stderr.log").open("w") as err:
        process = subprocess.Popen(
            [sys.executable, "-m", "app.serve"], cwd=REPO_ROOT / "api", env=env, stderr=err
        )
        try:
            seen = None
            deadline = time.monotonic() + 20
            while seen != "ok" and time.monotonic() < deadline:
                seen = health_worker(port)
                time.sleep(0.2)
            assert seen == "ok"
        finally:
            process.send_signal(signal.SIGTERM)
            assert process.wait(timeout=30) == 0


def health_worker(port: int) -> str | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as response:
            body: dict[str, str] = json.loads(response.read())
            return body["worker"]
    except OSError:
        return None


def test_health_is_200_when_the_privileged_database_refuses_connections(app: FastAPI) -> None:
    unreachable = make_engine("postgresql+psycopg://nobody@127.0.0.1:1/none")
    app.dependency_overrides[get_queue_bind] = lambda: unreachable
    response = TestClient(app).get("/health")
    unreachable.dispose()
    assert response.status_code == 200
    assert response.json()["worker"] == "stale"


def test_health_is_503_when_the_database_refuses_connections(
    migrated_engine: Engine,
) -> None:

    app = create_app()
    unreachable = make_engine("postgresql+psycopg://nobody@127.0.0.1:1/none")
    app.dependency_overrides[get_db_bind] = lambda: unreachable
    response = TestClient(app).get("/health")
    unreachable.dispose()
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "database_unavailable"
