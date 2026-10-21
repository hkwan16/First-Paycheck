"""GET /health against the migrated test database."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine

from app.db import make_engine
from app.deps import get_db_bind
from app.main import create_app
from tests.support.database import head_revision


def test_health_reports_the_migrated_revision(app: FastAPI) -> None:
    response = TestClient(app).get("/health")
    assert response.status_code == 200
    assert response.json()["alembic_revision"] == head_revision()


def test_health_uses_the_configured_engine(migrated_engine: Engine) -> None:
    # No dependency overrides: the app builds its own engine from DATABASE_URL.
    response = TestClient(create_app()).get("/health")
    assert response.status_code == 200
    assert response.json()["alembic_revision"] == head_revision()


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
