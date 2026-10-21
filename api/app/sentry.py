"""Error reporting to Sentry, gated on ``SENTRY_DSN``.

Unset (local, tests, CI): nothing beyond the settings check runs, and
``sentry_sdk`` is never imported. Set (Render): ``app.main`` initialises it
for the API with the Starlette and FastAPI integrations and ``jobs.worker``
for the worker, with ``environment=APP_ENV`` and ``release`` the deployed
commit. Unhandled exceptions and ERROR log lines become events (a job that
gives up logs at ERROR); INFO lines become breadcrumbs.

Privacy: ``send_default_pii=False``, request bodies are never read
(``max_request_body_size="never"``), frame locals are not sent (they could
hold a pay stub's values or a token), and ``before_send`` drops whatever
request body, cookies and ``Authorization`` header an integration still
attached.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Any, Literal

from app.config import Settings
from app.version import resolve_git_sha

if TYPE_CHECKING:
    from sentry_sdk.types import Event, Hint

__all__ = ["Component", "init_sentry", "scrubber"]

Component = Literal["api", "worker"]


def scrubber(component: Component) -> Callable[[Event, Hint], Event | None]:
    """The ``before_send`` hook: strip bodies and credentials, tag the process."""

    def before_send(event: Event, hint: Hint) -> Event | None:
        request: dict[str, Any] | None = event.get("request")
        if request is not None:
            request.pop("data", None)
            request.pop("cookies", None)
            headers = request.get("headers")
            if headers:
                request["headers"] = {
                    name: value
                    for name, value in headers.items()
                    if name.lower() != "authorization"
                }
        # The API and the worker share one Render service; the tag tells them apart.
        event["tags"] = {**event.get("tags", {}), "component": component}
        return event

    return before_send


def init_sentry(settings: Settings, *, component: Component) -> bool:
    """Initialise the SDK when a DSN is configured. True when it was."""
    if settings.sentry_dsn is None:
        return False
    # Imported here so a process without a DSN never loads the SDK.
    import sentry_sdk
    from sentry_sdk.integrations.fastapi import FastApiIntegration
    from sentry_sdk.integrations.starlette import StarletteIntegration

    integrations = [StarletteIntegration(), FastApiIntegration()] if component == "api" else []
    sentry_sdk.init(
        dsn=settings.sentry_dsn.get_secret_value(),
        environment=settings.app_env,
        release=resolve_git_sha(settings.git_sha),
        send_default_pii=False,
        max_request_body_size="never",
        include_local_variables=False,
        before_send=scrubber(component),
        integrations=integrations,
    )
    return True
