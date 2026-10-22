"""Liveness and deploy verification."""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from app.config import plaid_missing_settings
from app.deps import SettingsDep, alembic_revision, worker_state
from app.errors import error_responses
from jobs.scheduler import WorkerStatus

router = APIRouter(tags=["health"])


class PlaidHealth(BaseModel):
    env: Literal["sandbox", "production"]
    # Environment-variable names still unset; empty means bank linking works.
    missing: list[str]


class Health(BaseModel):
    status: Literal["ok"]
    git_sha: str
    alembic_revision: str | None
    # Informational: a stale worker does not fail the health check.
    worker: WorkerStatus
    plaid: PlaidHealth


@router.get("/health", responses=error_responses(503))
def health(
    request: Request,
    revision: Annotated[str | None, Depends(alembic_revision)],
    worker: Annotated[WorkerStatus, Depends(worker_state)],
    settings: SettingsDep,
) -> Health:
    """The running commit, the database's migration revision, whether the
    worker was active in the last 5 minutes and whether Plaid is configured
    (setting names only). No auth."""
    return Health(
        status="ok",
        git_sha=request.app.state.git_sha,
        alembic_revision=revision,
        worker=worker,
        plaid=PlaidHealth(env=settings.plaid_env, missing=plaid_missing_settings(settings)),
    )
