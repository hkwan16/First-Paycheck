"""A path id that is not a UUID names no row, so it is 404 ``not_found``, the
same answer as an unknown id or another user's (spec 001 rules 12 and 12a).
A 422 would read as a request the client could fix and send again (issue 237).
"""

from __future__ import annotations

import re
from collections.abc import Callable

import pytest
from fastapi.routing import APIRoute, iter_route_contexts
from fastapi.testclient import TestClient

from app.main import create_app
from tests.conftest import FixtureUser

MALFORMED = "not-a-uuid"
PATH_PARAMETER = re.compile(r"\{[^}]+\}")


def id_routes() -> list[tuple[str, str]]:
    """Every ``(method, path)`` whose path names a row by id."""
    return sorted(
        (method, str(context.path))
        for context in iter_route_contexts(create_app().routes)
        if isinstance(context.original_route, APIRoute) and PATH_PARAMETER.search(str(context.path))
        for method in context.methods or ()
    )


def test_the_api_has_id_routes_to_check() -> None:
    assert ("GET", "/decisions/{decision_id}") in id_routes()
    assert ("GET", "/check-ins/{check_in_id}") in id_routes()
    assert ("GET", "/docs/{document_id}") in id_routes()


@pytest.mark.parametrize(("method", "path"), id_routes(), ids=lambda part: str(part))
def test_a_malformed_id_is_not_found(
    client_as: Callable[[FixtureUser], TestClient], user_a: FixtureUser, method: str, path: str
) -> None:
    url = PATH_PARAMETER.sub(MALFORMED, path)
    body: dict[str, object] | None = {} if method in {"POST", "PATCH", "PUT"} else None
    response = client_as(user_a).request(method, url, json=body)
    assert response.status_code == 404, response.text
    assert response.json()["error"]["code"] == "not_found"
