"""Fixtures for the plan export tests: the frozen clock, spec 016's plan user
and a worker that runs jobs inside the test's transaction."""

from __future__ import annotations

from collections.abc import Callable

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Connection, text

from app.deps import get_now
from jobs.context import Services
from jobs.worker import Worker
from tests.conftest import FixtureUser
from tests.support.plan_user import NOW, PlanUser, seed_plan_user

Client = Callable[[FixtureUser], TestClient]


@pytest.fixture
def frozen_app(app: FastAPI, db_connection: Connection) -> FastAPI:
    """The app at spec 016's clock, with no committed jobs in the queue (rolled back)."""
    db_connection.execute(text("DELETE FROM jobs"))
    app.dependency_overrides[get_now] = lambda: NOW
    return app


@pytest.fixture
def plan_user(
    frozen_app: FastAPI,
    client_as: Client,
    user_a: FixtureUser,
    db_connection: Connection,
    seeded_citations: Connection,
) -> PlanUser:
    return seed_plan_user(db_connection, client_as(user_a), user_a.id)


@pytest.fixture
def worker(db_connection: Connection) -> Worker:
    """The real handlers on the job clock ``NOW``, bound to the test's connection."""
    return Worker(
        services=Services(clock=lambda: NOW),
        queue_bind=db_connection,
        user_bind=db_connection,
    )
