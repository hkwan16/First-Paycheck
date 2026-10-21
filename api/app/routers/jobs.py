"""Background job status, for clients polling a sync or extraction (spec 002)."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from app.deps import UserSession
from app.errors import NotFound, error_responses
from app.types import UtcDateTime
from db.enums import JobKind, JobStatus
from db.models import Job

router = APIRouter(prefix="/jobs", tags=["jobs"])


class JobOut(BaseModel):
    id: uuid.UUID
    kind: JobKind
    status: JobStatus
    # 0-100.
    progress: int
    result: dict[str, Any] | None
    last_error: str | None
    created_at: UtcDateTime
    finished_at: UtcDateTime | None


@router.get("/{job_id}", responses=error_responses(401, 404, 422))
def get_job(job_id: uuid.UUID, session: UserSession) -> JobOut:
    """One of the user's jobs."""
    job = session.get(Job, job_id)
    if job is None:
        raise NotFound("Job not found")
    return JobOut(
        id=job.id,
        kind=job.kind,
        status=job.status,
        progress=job.progress,
        result=job.result,
        last_error=job.last_error,
        created_at=job.created_at,
        finished_at=job.finished_at,
    )
