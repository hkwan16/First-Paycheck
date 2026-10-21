"""Liveness and deploy verification."""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from app.deps import alembic_revision, worker_state
from app.errors import error_responses
from jobs.scheduler import WorkerStatus

router = APIRouter(tags=["health"])


class Health(BaseModel):
    status: Literal["ok"]
    git_sha: str
    alembic_revision: str | None
    # Informational: a stale worker does not fail the health check.
    worker: WorkerStatus


@router.get("/health", responses=error_responses(503))
def health(
    request: Request,
    revision: Annotated[str | None, Depends(alembic_revision)],
    worker: Annotated[WorkerStatus, Depends(worker_state)],
) -> Health:
    """The running commit, the database's migration revision and whether the
    worker was active in the last 5 minutes. No auth."""
    return Health(
        status="ok", git_sha=request.app.state.git_sha, alembic_revision=revision, worker=worker
    )
