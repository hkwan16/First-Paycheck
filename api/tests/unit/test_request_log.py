"""One structured log line per request, tied together by a request id."""

from __future__ import annotations

import logging
import uuid
from typing import Annotated, Any

import pytest
from fastapi import APIRouter, Depends, FastAPI
from fastapi.testclient import TestClient

from app.auth import AuthUser, get_current_user
from app.config import Settings
from app.deps import alembic_revision
from app.logs import JsonFormatter
from app.main import create_app
from tests.support.tokens import make_token

USER_ID = uuid.UUID("22222222-2222-4222-8222-222222222222")
ORIGIN = "https://first-paycheck.example"


def build_app() -> FastAPI:
    app = create_app(Settings(_env_file=None, cors_origins=[ORIGIN]))
    app.dependency_overrides[alembic_revision] = lambda: "0001_roles"
    router = APIRouter()

    @router.post("/whoami")
    def whoami(user: Annotated[AuthUser, Depends(get_current_user)]) -> dict[str, str]:
        logging.getLogger("app.test").info("inside the route")
        return {"id": str(user.id)}

    @router.get("/boom")
    def boom() -> None:
        raise RuntimeError("unexpected")

    app.include_router(router)
    return app


@pytest.fixture
def client() -> TestClient:
    return TestClient(build_app(), raise_server_exceptions=False)


def request_lines(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.name == "app.request"]


def fields(record: logging.LogRecord) -> dict[str, Any]:
    return dict(vars(record))


def test_one_line_per_request_with_method_path_status_and_duration(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)
    response = client.get("/health?probe=1")
    assert response.status_code == 200
    [line] = request_lines(caplog)
    entry = fields(line)
    assert (entry["method"], entry["path"], entry["status"]) == ("GET", "/health", 200)
    assert isinstance(entry["duration_ms"], float)
    assert entry["duration_ms"] >= 0
    assert "user_id" not in entry
    assert entry["request_id"] == response.headers["X-Request-Id"]
    assert len(entry["request_id"]) == 32


def test_an_incoming_request_id_is_kept(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)
    response = client.get("/health", headers={"X-Request-Id": "abc-123_x.y"})
    assert response.headers["X-Request-Id"] == "abc-123_x.y"
    assert fields(request_lines(caplog)[0])["request_id"] == "abc-123_x.y"


@pytest.mark.parametrize("incoming", ["", "a" * 129, "has space", 'quote"', "line\\nbreak"])
def test_an_unusable_request_id_is_replaced(client: TestClient, incoming: str) -> None:
    response = client.get("/health", headers={"X-Request-Id": incoming})
    assert response.headers["X-Request-Id"] != incoming
    assert len(response.headers["X-Request-Id"]) == 32


def test_authenticated_requests_carry_the_user_id_and_never_the_token(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)
    token = make_token(USER_ID)
    response = client.post(
        "/whoami", headers={"Authorization": f"Bearer {token}"}, json={"salary_cents": 6_000_000}
    )
    assert response.status_code == 200
    [line] = request_lines(caplog)
    assert fields(line)["user_id"] == str(USER_ID)
    # Lines written inside the request share its id.
    [inside] = [r for r in caplog.records if r.name == "app.test"]
    rendered = JsonFormatter().format(inside)
    assert response.headers["X-Request-Id"] in rendered
    everything = "\n".join(JsonFormatter().format(r) for r in caplog.records)
    assert token not in everything
    assert "Bearer" not in everything
    assert "6000000" not in everything


def test_a_rejected_token_still_logs_the_request_without_a_user(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)
    response = client.post("/whoami", headers={"Authorization": "Bearer junk"})
    assert response.status_code == 401
    [line] = request_lines(caplog)
    assert fields(line)["status"] == 401
    assert "user_id" not in fields(line)


def test_an_unhandled_error_logs_500_and_returns_the_request_id(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)
    response = client.get("/boom", headers={"X-Request-Id": "trace-me"})
    assert response.status_code == 500
    assert response.json() == {
        "error": {"code": "internal_error", "message": "Internal server error"}
    }
    assert response.headers["X-Request-Id"] == "trace-me"
    [line] = request_lines(caplog)
    assert (fields(line)["status"], fields(line)["request_id"]) == (500, "trace-me")
    [traceback] = [r for r in caplog.records if r.name == "app.errors"]
    assert fields(traceback)["request_id"] == "trace-me"


def test_the_browser_can_read_the_request_id(client: TestClient) -> None:
    response = client.get("/health", headers={"Origin": ORIGIN})
    exposed = {h.strip() for h in response.headers["access-control-expose-headers"].split(",")}
    assert "X-Request-Id" in exposed
