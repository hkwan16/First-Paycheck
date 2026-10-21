"""The committed OpenAPI document matches the app and uses stable operation ids."""

from __future__ import annotations

import json
import subprocess
import sys

from fastapi.testclient import TestClient

from app.config import REPO_ROOT, Settings
from app.main import create_app
from app.openapi import render_openapi

COMMITTED = REPO_ROOT / "api" / "openapi.json"
HTTP_METHODS = {"get", "post", "put", "patch", "delete"}


def operations(document: dict[str, object]) -> list[dict[str, object]]:
    paths = document["paths"]
    assert isinstance(paths, dict)
    return [op for item in paths.values() for method, op in item.items() if method in HTTP_METHODS]


def test_committed_openapi_matches_the_app() -> None:
    assert COMMITTED.read_text() == render_openapi(), (
        "api/openapi.json is stale: run `make types` and commit the result"
    )


def test_operation_ids_are_route_names_and_unique() -> None:
    document = json.loads(render_openapi())
    ids = [op["operationId"] for op in operations(document)]
    assert len(ids) == len(set(ids))
    assert "health" in ids


def test_render_is_deterministic_json_with_a_trailing_newline() -> None:
    text = render_openapi()
    assert text.endswith("}\n")
    assert text == render_openapi()


def test_error_shape_is_documented() -> None:
    schemas = json.loads(render_openapi())["components"]["schemas"]
    assert set(schemas["ErrorResponse"]["properties"]) == {"error"}
    assert set(schemas["ErrorDetail"]["properties"]) == {"code", "message", "details"}
    assert set(schemas["ErrorDetail"]["required"]) == {"code", "message"}


def test_interactive_docs_do_not_shadow_the_documents_routes() -> None:
    """``/docs`` is the documents API, so Swagger UI lives at ``/api-docs``."""
    client = TestClient(create_app(Settings(_env_file=None)))
    assert "swagger-ui" in client.get("/api-docs").text
    assert client.get("/docs").status_code == 401


def test_module_entrypoint_prints_the_document() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "app.openapi"],
        capture_output=True,
        text=True,
        check=True,
        cwd=REPO_ROOT / "api",
    )
    assert result.stdout == render_openapi()
