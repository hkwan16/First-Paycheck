"""Sentry is env-gated: with SENTRY_DSN set the API and the worker report errors,
scrubbed of request bodies and credentials; without it the SDK is never loaded."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import Any

import pytest
import sentry_sdk
from pydantic import SecretStr
from sentry_sdk.types import Event

from app import sentry
from app.config import REPO_ROOT, Settings
from app.main import create_app
from jobs import worker

DSN = "https://public@o0.ingest.sentry.io/0"


@pytest.fixture
def init_calls(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr(sentry_sdk, "init", lambda **kwargs: calls.append(kwargs))
    return calls


def with_dsn(**values: Any) -> Settings:
    values.setdefault("app_env", "development")
    return Settings(_env_file=None, sentry_dsn=SecretStr(DSN), git_sha="cafe123", **values)


def test_tests_never_see_a_real_dsn() -> None:
    assert os.environ["SENTRY_DSN"] == ""


def test_without_a_dsn_nothing_is_initialised(init_calls: list[dict[str, Any]]) -> None:
    assert sentry.init_sentry(Settings(_env_file=None), component="api") is False
    assert init_calls == []


def test_with_a_dsn_the_sdk_is_initialised_privately(init_calls: list[dict[str, Any]]) -> None:
    assert sentry.init_sentry(with_dsn(), component="api") is True
    [options] = init_calls
    assert options["dsn"] == DSN
    assert options["environment"] == "development"
    assert options["release"] == "cafe123"
    assert options["send_default_pii"] is False
    # Bodies are never read, and frame locals (a pay stub, a token) never leave.
    assert options["max_request_body_size"] == "never"
    assert options["include_local_variables"] is False
    assert callable(options["before_send"])


def test_the_api_initialises_sentry_when_configured(init_calls: list[dict[str, Any]]) -> None:
    create_app(with_dsn())
    [options] = init_calls
    assert options["before_send"]({}, {})["tags"] == {"component": "api"}


def test_the_api_does_not_initialise_sentry_without_a_dsn(
    init_calls: list[dict[str, Any]],
) -> None:
    create_app(Settings(_env_file=None))
    assert init_calls == []


def test_the_worker_initialises_sentry_when_configured(
    init_calls: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(worker, "get_settings", with_dsn)
    monkeypatch.setattr(worker, "default_services", lambda _: None)
    monkeypatch.setattr(worker, "configure_logging", lambda: None)
    monkeypatch.setattr(worker.signal, "signal", lambda *_: None)
    monkeypatch.setattr(worker.Worker, "run", lambda self, stop: 0)
    assert worker.main() == 0
    [options] = init_calls
    assert options["before_send"]({}, {})["tags"] == {"component": "worker"}


def test_before_send_strips_bodies_and_credentials() -> None:
    event: Event = {
        "request": {
            "url": "https://api.example/docs/1/confirm",
            "method": "POST",
            "data": {"gross_pay_cents": 250_000},
            "headers": {
                "Authorization": "Bearer eyJ.secret",
                "content-type": "application/json",
            },
            "cookies": {"session": "x"},
        },
        "tags": {"existing": "kept"},
    }
    scrubbed = sentry.scrubber("api")(event, {})
    assert scrubbed is not None
    assert "data" not in scrubbed["request"]
    assert "cookies" not in scrubbed["request"]
    assert scrubbed["request"]["headers"] == {"content-type": "application/json"}
    assert scrubbed["request"]["url"] == "https://api.example/docs/1/confirm"
    assert scrubbed["tags"] == {"existing": "kept", "component": "api"}


def test_before_send_matches_the_authorization_header_in_any_case() -> None:
    event: Event = {"request": {"headers": {"authorization": "Bearer x"}}}
    scrubbed = sentry.scrubber("worker")(event, {})
    assert scrubbed is not None
    assert scrubbed["request"]["headers"] == {}


# Runs in a child process: sentry_sdk.init installs a process-wide client.
REAL_SDK_PROBE = """
import json, sys
import sentry_sdk
from sentry_sdk.transport import Transport
from fastapi.testclient import TestClient
from pydantic import SecretStr
from app.config import Settings
from app.main import create_app

envelopes = []

class Memory(Transport):
    def capture_envelope(self, envelope):
        envelopes.append(envelope.serialize().decode())

real_init = sentry_sdk.init
sentry_sdk.init = lambda **options: real_init(transport=Memory(options), **options)
app = create_app(Settings(_env_file=None, sentry_dsn=SecretStr(sys.argv[1]), git_sha="cafe123"))

@app.post("/boom")
def boom(body: dict) -> None:
    gross_pay_local = "PAYSTUB-GROSS-250000"
    raise RuntimeError("unexpected " + str(len(gross_pay_local)))

client = TestClient(app, raise_server_exceptions=False)
response = client.post(
    "/boom",
    json={"ssn": "BODY-SSN-123456789"},
    headers={"Authorization": "Bearer TOKEN-abc.def"},
)
assert response.status_code == 500, response.status_code
sentry_sdk.flush()
print(json.dumps(envelopes))
"""


def test_the_real_sdk_reports_a_500_without_bodies_tokens_or_locals() -> None:
    env = {**os.environ, "APP_ENV": "test"}
    result = subprocess.run(
        [sys.executable, "-c", REAL_SDK_PROBE, DSN],
        cwd=REPO_ROOT / "api",
        capture_output=True,
        text=True,
        check=True,
        env=env,
    )
    envelopes: list[str] = json.loads(result.stdout.strip().splitlines()[-1])
    events = [
        line for envelope in envelopes for line in envelope.splitlines() if '"exception"' in line
    ]
    assert events, envelopes
    event = json.loads(events[0])
    assert event["exception"]["values"][-1]["type"] == "RuntimeError"
    assert event["tags"]["component"] == "api"
    assert (event["environment"], event["release"]) == ("test", "cafe123")
    sent = "\n".join(envelopes)
    for secret in ("BODY-SSN-123456789", "TOKEN-abc.def", "PAYSTUB-GROSS-250000"):
        assert secret not in sent


def test_without_a_dsn_no_process_loads_the_sdk() -> None:
    probe = "import sys, app.main, jobs.worker, app.serve; print('sentry_sdk' in sys.modules)"
    env = {**os.environ, "APP_ENV": "test", "SENTRY_DSN": ""}
    result = subprocess.run(
        [sys.executable, "-c", probe],
        cwd=REPO_ROOT / "api",
        capture_output=True,
        text=True,
        check=True,
        env=env,
    )
    assert result.stdout.strip() == "False"
