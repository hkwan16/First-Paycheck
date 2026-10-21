"""Cross-origin responses expose the headers the web client reads."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.config import Settings
from app.deps import alembic_revision
from app.main import create_app

ORIGIN = "https://first-paycheck.example"


def client() -> TestClient:
    app = create_app(Settings(_env_file=None, cors_origins=[ORIGIN]))
    app.dependency_overrides[alembic_revision] = lambda: "0001_roles"
    return TestClient(app)


def test_allowed_origin_can_read_retry_after() -> None:
    # The browser hides every non-simple response header from scripts unless
    # it is listed here, so a 429's Retry-After would otherwise read as null.
    response = client().get("/health", headers={"Origin": ORIGIN})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == ORIGIN
    exposed = {h.strip() for h in response.headers["access-control-expose-headers"].split(",")}
    assert "Retry-After" in exposed


def test_other_origins_get_no_cors_headers() -> None:
    response = client().get("/health", headers={"Origin": "https://evil.example"})
    assert response.status_code == 200
    assert "access-control-allow-origin" not in response.headers
