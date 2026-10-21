"""Liveness and deploy verification."""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from app.deps import alembic_revision
from app.errors import error_responses

router = APIRouter(tags=["health"])


class Health(BaseModel):
    status: Literal["ok"]
    git_sha: str
    alembic_revision: str | None


@router.get("/health", responses=error_responses(503))
def health(request: Request, revision: Annotated[str | None, Depends(alembic_revision)]) -> Health:
    """The running commit and the database's migration revision. No auth."""
    return Health(status="ok", git_sha=request.app.state.git_sha, alembic_revision=revision)
