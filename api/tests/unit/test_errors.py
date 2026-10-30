"""Every error leaves the API as {"error": {"code", "message"}}."""

from __future__ import annotations

from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel, model_validator

from app.errors import AppError, NotFound, Unauthorized, install_error_handlers


class Payload(BaseModel):
    amount_cents: int


class Range(BaseModel):
    low_cents: int
    high_cents: int

    @model_validator(mode="after")
    def _ordered(self) -> Range:
        if self.low_cents > self.high_cents:
            raise ValueError("The low end must not be more than the high end")
        return self


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

    @router.post("/range")
    def range_(body: Range) -> Range:
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


def test_a_validators_own_sentence_is_the_message() -> None:
    """Spec 008 rule 22a: a validator's ValueError is written for people, so it
    leaves as it is, without the field path and pydantic's "Value error" prefix."""
    response = client.post("/range", json={"low_cents": 5, "high_cents": 1})
    assert response.status_code == 422
    assert response.json() == {
        "error": {
            "code": "validation_error",
            "message": "The low end must not be more than the high end",
        }
    }


def test_details_and_headers_travel_with_the_error() -> None:
    app = FastAPI()
    install_error_handlers(app)

    @app.get("/unbalanced")
    def unbalanced() -> None:
        raise AppError(
            "Off by two cents",
            code="pay_stub_unbalanced",
            status_code=422,
            details={"difference_cents": -2},
            headers={"X-Example": "1"},
        )

    response = TestClient(app).get("/unbalanced")
    assert response.status_code == 422
    assert response.headers["x-example"] == "1"
    assert response.json() == {
        "error": {
            "code": "pay_stub_unbalanced",
            "message": "Off by two cents",
            "details": {"difference_cents": -2},
        }
    }


def test_unhandled_exception_hides_internals() -> None:
    response = client.get("/boom")
    assert response.status_code == 500
    assert response.json() == {
        "error": {"code": "internal_error", "message": "Internal server error"}
    }
