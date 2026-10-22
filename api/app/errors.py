"""The API's single error shape: ``{"error": {"code": str, "message": str}}``.

Routes raise ``AppError`` (or a subclass). Framework errors (unknown route,
validation, unhandled exceptions) are translated into the same shape so the
client has one thing to parse.
"""

from __future__ import annotations

import logging
from http import HTTPStatus
from typing import Any, cast

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.request_log import REQUEST_ID_HEADER, request_id_of

logger = logging.getLogger(__name__)


class ErrorDetail(BaseModel):
    code: str
    message: str
    # Machine-readable specifics for errors the client acts on (for example
    # the arithmetic of ``pay_stub_unbalanced``); omitted when there are none.
    details: dict[str, Any] | None = None


class ErrorResponse(BaseModel):
    error: ErrorDetail


class AppError(Exception):
    """An error the client is meant to see."""

    status_code: int = 400
    code: str = "bad_request"
    headers: dict[str, str] | None = None

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        status_code: int | None = None,
        details: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.details = details
        if code is not None:
            self.code = code
        if status_code is not None:
            self.status_code = status_code
        if headers is not None:
            self.headers = headers


class Unauthorized(AppError):
    status_code = 401
    code = "unauthorized"
    headers = {"WWW-Authenticate": "Bearer"}  # noqa: RUF012 (read-only class constant)


class NotFound(AppError):
    """Also used for rows owned by another user: cross-user access is a 404, never a 403."""

    status_code = 404
    code = "not_found"


def error_responses(*status_codes: int) -> dict[int | str, dict[str, Any]]:
    """OpenAPI ``responses`` entries documenting the error shape for these codes."""
    return {
        code: {"model": ErrorResponse, "description": HTTPStatus(code).phrase}
        for code in status_codes
    }


def error_body(code: str, message: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
    error = ErrorDetail(code=code, message=message, details=details)
    return ErrorResponse(error=error).model_dump(exclude_none=True)


def _status_code_name(status_code: int) -> str:
    try:
        return HTTPStatus(status_code).phrase.lower().replace(" ", "_").replace("-", "_")
    except ValueError:
        return "error"


# Starlette types every handler as (Request, Exception); each handler below is
# registered for exactly one exception class, so the casts are safe.


async def _app_error(_: Request, error: Exception) -> JSONResponse:
    exc = cast(AppError, error)
    return JSONResponse(
        error_body(exc.code, exc.message, exc.details),
        status_code=exc.status_code,
        headers=exc.headers,
    )


async def _http_error(_: Request, error: Exception) -> JSONResponse:
    exc = cast(StarletteHTTPException, error)
    message = exc.detail if isinstance(exc.detail, str) else HTTPStatus(exc.status_code).phrase
    return JSONResponse(
        error_body(_status_code_name(exc.status_code), message),
        status_code=exc.status_code,
        headers=exc.headers,
    )


async def _validation_error(_: Request, error: Exception) -> JSONResponse:
    exc = cast(RequestValidationError, error)
    parts = []
    for item in exc.errors():
        location = ".".join(str(part) for part in item.get("loc", ()))
        parts.append(f"{location}: {item.get('msg', 'invalid')}")
    return JSONResponse(
        error_body("validation_error", "; ".join(parts) or "Invalid request"), status_code=422
    )


async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
    # Starlette runs this outside every middleware, so the request id comes
    # from the request's state (app.request_log) rather than the log context.
    request_id = request_id_of(request.scope)
    logger.exception(
        "unhandled error on %s %s",
        request.method,
        request.url.path,
        exc_info=exc,
        extra={"request_id": request_id} if request_id else None,
    )
    return JSONResponse(
        error_body("internal_error", "Internal server error"),
        status_code=500,
        headers={REQUEST_ID_HEADER: request_id} if request_id else None,
    )


# Every user table's key to auth.users is named fk_<table>_user_id_users (spec
# 001 naming convention; test_account_deletion checks it).
_OWNER_KEY_SUFFIX = "_user_id_users"
_FOREIGN_KEY_VIOLATION = "23503"


def is_missing_owner(exc: IntegrityError) -> bool:
    """True when a write failed because its ``user_id`` names no ``auth.users``
    row: the account was deleted while its access token is still valid."""
    diag = getattr(exc.orig, "diag", None)
    constraint = getattr(diag, "constraint_name", None) or ""
    return getattr(exc.orig, "sqlstate", None) == _FOREIGN_KEY_VIOLATION and constraint.endswith(
        _OWNER_KEY_SUFFIX
    )


async def _integrity_error(request: Request, error: Exception) -> JSONResponse:
    exc = cast(IntegrityError, error)
    if is_missing_owner(exc):
        # Spec 017 rule 9: the client signs out instead of seeing a 500.
        return JSONResponse(
            error_body("account_deleted", "This account has been deleted"),
            status_code=401,
            headers=Unauthorized.headers,
        )
    return await _unhandled(request, exc)


def install_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(AppError, _app_error)
    app.add_exception_handler(IntegrityError, _integrity_error)
    app.add_exception_handler(StarletteHTTPException, _http_error)
    app.add_exception_handler(RequestValidationError, _validation_error)
    app.add_exception_handler(Exception, _unhandled)
