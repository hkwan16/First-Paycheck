"""Every write route has a per-user rate limit or a written reason not to
(``app/ratelimit.py:WRITE_ROUTE_POLICIES``), and every request body is bounded
(``app/body_limit.py``)."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.routing import APIRoute, iter_route_contexts
from fastapi.testclient import TestClient

from app import ratelimit
from app.body_limit import DEFAULT_MAX_BODY_BYTES
from app.config import Settings
from app.main import create_app

READS = {"GET", "HEAD"}


def write_routes() -> set[str]:
    app = create_app(Settings(_env_file=None))
    # Included routers are opaque in app.routes; iter_route_contexts flattens them.
    return {
        context.original_route.name
        for context in iter_route_contexts(app.routes)
        if isinstance(context.original_route, APIRoute) and set(context.methods or ()) - READS
    }


def test_every_write_route_has_a_policy() -> None:
    routes = write_routes()
    policies = set(ratelimit.WRITE_ROUTE_POLICIES)
    assert routes == policies, (
        f"without a policy: {sorted(routes - policies)}; stale: {sorted(policies - routes)}"
    )


def test_policies_are_limits_or_reasons() -> None:
    buckets = []
    for name, policy in ratelimit.WRITE_ROUTE_POLICIES.items():
        if isinstance(policy, ratelimit.Limit):
            assert policy.limit > 0, name
            buckets.append(policy.bucket)
        else:
            assert len(policy) > 20, f"{name}: say why it needs no limit"
    # A bucket counts one kind of request; two routes never share one.
    assert len(buckets) == len(set(buckets))


@pytest.fixture
def client() -> Iterator[TestClient]:
    # No token and no database: the size check runs before either.
    with TestClient(create_app(Settings(_env_file=None))) as client:
        yield client


def test_an_oversized_json_body_is_refused_before_it_is_read(client: TestClient) -> None:
    response = client.post(
        "/calc/w4",
        content=b"{}",
        headers={"Content-Type": "application/json", "Content-Length": "2000000"},
    )
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "body_too_large"


def test_a_streamed_body_is_cut_off_at_the_limit(client: TestClient) -> None:
    """A chunked body has no Content-Length, so the bytes are counted."""

    def chunks() -> Iterator[bytes]:
        yield b'{"padding": "'
        for _ in range(DEFAULT_MAX_BODY_BYTES // 65_536 + 2):
            yield b"x" * 65_536
        yield b'"}'

    response = client.put(
        "/profile", content=chunks(), headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "body_too_large"


def test_the_webhook_is_bounded_too(client: TestClient) -> None:
    response = client.post("/sync/webhook", content=b"x" * (DEFAULT_MAX_BODY_BYTES + 1))
    assert response.status_code == 413


def test_a_body_under_the_limit_reaches_the_route(client: TestClient) -> None:
    # It gets as far as authentication.
    response = client.put("/profile", json={"padding": "x" * 1000})
    assert response.status_code == 401


def test_uploads_keep_their_own_larger_limit(client: TestClient) -> None:
    response = client.post(
        "/docs",
        content=b"tiny",
        headers={
            "Content-Type": "multipart/form-data; boundary=x",
            "Content-Length": str(5 * 1024 * 1024),
        },
    )
    # Past the size check: the stand-in body then fails to parse as multipart.
    assert response.status_code != 413
