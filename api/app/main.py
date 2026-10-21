"""The FastAPI application. ``uvicorn app.main:app`` serves it."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.routing import APIRoute

from app.config import Settings, get_settings
from app.db import dispose_engines
from app.errors import install_error_handlers
from app.routers import accounts, health, jobs, sync, transactions
from app.version import resolve_git_sha

API_VERSION = "0.1.0"


def operation_id(route: APIRoute) -> str:
    """Stable operation ids: the route function's name.

    The generated TypeScript client keys on these, so renaming a route
    function is an API change. ``tests/unit/test_openapi.py`` checks uniqueness.
    """
    return route.name


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    yield
    # Return pooled connections to Postgres on shutdown instead of dropping them.
    dispose_engines()


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    app = FastAPI(
        title="First Paycheck API",
        version=API_VERSION,
        generate_unique_id_function=operation_id,
        lifespan=lifespan,
    )
    app.state.git_sha = resolve_git_sha(settings.git_sha)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_origin_regex=settings.cors_origin_regex,
        # Auth is a bearer token, never a cookie.
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
        max_age=600,
    )
    install_error_handlers(app)
    app.include_router(health.router)
    app.include_router(sync.router)
    app.include_router(accounts.router)
    app.include_router(transactions.router)
    app.include_router(jobs.router)
    return app


app = create_app()
