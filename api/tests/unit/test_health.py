"""GET /health reports the deployed git SHA and the database's Alembic revision."""

from __future__ import annotations

import subprocess

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app import version
from app.config import Settings, get_settings
from app.db import make_engine
from app.deps import alembic_revision, worker_state
from app.errors import AppError
from app.main import create_app
from tests.support.env import TEST_PLAID_TOKEN_KEY


def client_with(
    revision: str | None, *, git_sha: str = "deadbeef", worker: str = "ok"
) -> TestClient:
    # The test environment pins a PLAID_TOKEN_KEY; drop it so the Plaid report
    # is deterministic. Routes read settings through get_settings, so it is
    # overridden too.
    settings = Settings(_env_file=None, git_sha=git_sha, plaid_token_key=None)
    app = create_app(settings)
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[alembic_revision] = lambda: revision
    app.dependency_overrides[worker_state] = lambda: worker
    return TestClient(app)


def test_health_reports_sha_and_revision() -> None:
    response = client_with("0001_roles").get("/health")
    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "git_sha": "deadbeef",
        "alembic_revision": "0001_roles",
        "worker": "ok",
        # Settings(_env_file=None) carries no Plaid credentials: /health names
        # what is missing (never a value) so a deployment can be checked from
        # outside.
        "plaid": {
            "env": "sandbox",
            "missing": ["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_TOKEN_KEY"],
        },
    }


def test_health_reports_plaid_configured_without_values() -> None:
    settings = Settings(
        _env_file=None,
        git_sha="deadbeef",
        plaid_client_id="cid",
        plaid_secret=SecretStr("sekrit"),
        plaid_token_key=SecretStr(TEST_PLAID_TOKEN_KEY),
        plaid_env="production",
    )
    app = create_app(settings)
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[alembic_revision] = lambda: "0001_roles"
    app.dependency_overrides[worker_state] = lambda: "ok"
    body = TestClient(app).get("/health").text
    assert '"plaid":{"env":"production","missing":[]}' in body.replace(" ", "")
    assert "sekrit" not in body
    assert TEST_PLAID_TOKEN_KEY not in body
    assert "cid" not in body


def test_health_is_200_when_the_worker_is_stale() -> None:
    # Render's health check and the keep-alive ping read the status; worker is for people.
    response = client_with("0001_roles", worker="stale").get("/health")
    assert response.status_code == 200
    assert response.json()["worker"] == "stale"


def test_an_unreachable_privileged_database_reads_as_a_stale_worker() -> None:
    unreachable = make_engine("postgresql+psycopg://nobody@127.0.0.1:1/none")
    try:
        assert worker_state(unreachable) == "stale"
    finally:
        unreachable.dispose()


def test_health_reports_a_database_without_migrations() -> None:
    response = client_with(None).get("/health")
    assert response.status_code == 200
    assert response.json()["alembic_revision"] is None


def test_health_is_503_when_the_database_is_unreachable() -> None:
    settings = Settings(_env_file=None, git_sha="deadbeef")
    app = create_app(settings)

    def unavailable() -> str | None:
        raise AppError("Database unavailable", code="database_unavailable", status_code=503)

    app.dependency_overrides[alembic_revision] = unavailable
    app.dependency_overrides[worker_state] = lambda: "ok"
    response = TestClient(app).get("/health")
    assert response.status_code == 503
    assert response.json() == {
        "error": {"code": "database_unavailable", "message": "Database unavailable"}
    }


def test_health_needs_no_auth() -> None:
    response = client_with("0001_roles").get("/health", headers={"Authorization": "Bearer junk"})
    assert response.status_code == 200


def test_git_sha_prefers_settings() -> None:
    assert version.resolve_git_sha("cafe") == "cafe"


def test_git_sha_falls_back_to_git_rev_parse() -> None:
    expected = subprocess.run(
        ["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True
    ).stdout.strip()
    assert version.resolve_git_sha(None) == expected


def test_git_sha_is_unknown_without_git(monkeypatch: pytest.MonkeyPatch) -> None:
    def no_git(*args: object, **kwargs: object) -> object:
        raise FileNotFoundError("git")

    monkeypatch.setattr(version.subprocess, "run", no_git)
    assert version.resolve_git_sha(None) == "unknown"


def test_git_sha_is_unknown_outside_a_repository(monkeypatch: pytest.MonkeyPatch) -> None:
    def not_a_repo(*args: object, **kwargs: object) -> object:
        raise subprocess.CalledProcessError(128, "git")

    monkeypatch.setattr(version.subprocess, "run", not_a_repo)
    assert version.resolve_git_sha(None) == "unknown"
