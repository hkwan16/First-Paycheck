"""Every error leaves the API as {"error": {"code", "message"}}."""

from __future__ import annotations

from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel

from app.errors import AppError, NotFound, Unauthorized, install_error_handlers


class Payload(BaseModel):
    amount_cents: int


def build_app() -> FastAPI:
    app = FastAPI()
    install_error_handlers(app)
    router = APIRouter()

    @router.get("/missing")
    def missing() -> None:
        raise NotFound("Decision not found")

    @router.get("/denied")
    def denied() -> None:
        raise Unauthorized("Token expired")

    @router.get("/teapot")
    def teapot() -> None:
        raise AppError("Short and stout", code="teapot", status_code=418)

    @router.post("/payload")
    def payload(body: Payload) -> Payload:
        return body

    @router.get("/boom")
    def boom() -> None:
        raise RuntimeError("secret internals")

    app.include_router(router)
    return app


client = TestClient(build_app(), raise_server_exceptions=False)


def test_app_error_subclass_shape() -> None:
    response = client.get("/missing")
    assert response.status_code == 404
    assert response.json() == {"error": {"code": "not_found", "message": "Decision not found"}}


def test_unauthorized_sets_the_bearer_challenge() -> None:
    response = client.get("/denied")
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    assert response.json() == {"error": {"code": "unauthorized", "message": "Token expired"}}


def test_custom_code_and_status() -> None:
    response = client.get("/teapot")
    assert response.status_code == 418
    assert response.json() == {"error": {"code": "teapot", "message": "Short and stout"}}


def test_unknown_route_uses_the_error_shape() -> None:
    response = client.get("/nope")
    assert response.status_code == 404
    assert response.json() == {"error": {"code": "not_found", "message": "Not Found"}}


def test_wrong_method_uses_the_error_shape() -> None:
    response = client.delete("/missing")
    assert response.status_code == 405
    assert response.json()["error"]["code"] == "method_not_allowed"


def test_validation_error_names_the_field() -> None:
    response = client.post("/payload", json={"amount_cents": "lots"})
    assert response.status_code == 422
    body = response.json()
    assert body["error"]["code"] == "validation_error"
    assert "body.amount_cents" in body["error"]["message"]


def test_unhandled_exception_hides_internals() -> None:
    response = client.get("/boom")
    assert response.status_code == 500
    assert response.json() == {
        "error": {"code": "internal_error", "message": "Internal server error"}
    }
