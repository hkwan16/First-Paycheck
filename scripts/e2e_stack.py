"""Run the web's real-API Playwright specs against a local, disposable stack.

    make e2e-full                                         # pnpm --dir web e2e, every project
    uv run python -m scripts.e2e_stack run -- <command>   # any command, with the stack's env
    uv run python -m scripts.e2e_stack up                 # start the stack and wait for Ctrl-C

What it starts, in order:

1. A disposable Postgres database, ``E2E_DATABASE_URL`` (default
   ``postgresql://localhost:5432/first_paycheck_e2e``; its name must contain
   ``e2e``): dropped and recreated, the test auth shim installed, migrated to
   head, seeded (as ``make seed``), and two fixture users added to
   ``auth.users``. ``app_api`` gets a login password made for this run.
2. ``FakeSupabaseAuth`` on 127.0.0.1:``E2E_AUTH_PORT``: a stand-in for
   Supabase Auth with the routes supabase-js uses (password and refresh-token
   grants, ``/user``, ``/logout``, the JWKS). It signs ES256 tokens with a key
   pair made for this run. The web signs in through its real form against it
   and the API verifies the same tokens through the JWKS, exactly as with the
   hosted project, so no app code knows it is under test.
3. The API and the worker together (``python -m app.serve``, as on Render) on
   ``E2E_API_PORT``, with ``APP_ENV=test`` (the API ignores the developer's
   ``.env``), ``LLM_FAKE=true``, CORS for the web origin, and the Plaid
   sandbox when ``PLAID_CLIENT_ID`` and ``PLAID_SECRET`` are in the
   environment or the repo's ``.env`` (never printed). Without them the
   Plaid-dependent specs skip (``E2E_PLAID_SANDBOX=0``).

The command (default ``pnpm --dir web e2e``) then runs with ``E2E_API_URL``,
``NEXT_PUBLIC_SUPABASE_URL``, the fixture users' credentials, ``E2E_PORT``
and ``E2E_PLAID_SANDBOX`` set; Playwright starts ``next dev`` with them. The
API's log and the auth stand-in's request log go to ``.e2e-stack/``.

``app_api``'s password is cluster-wide: on a cluster that checks passwords,
do not run this and ``make test`` (which sets its own) at the same time.
"""

from __future__ import annotations

import argparse
import contextlib
import http.client
import json
import os
import secrets
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, NamedTuple, TextIO, cast
from urllib.parse import parse_qs, urlsplit

import jwt
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives.asymmetric import ec
from dotenv import dotenv_values
from jwt.algorithms import ECAlgorithm
from pydantic import AliasChoices
from sqlalchemy import create_engine, make_url, text

from app.config import Settings
from db.seed.load import load as load_seed_data
from tests.support.auth_shim import ensure_auth_shim
from tests.support.database import drop_database as drop_named_database
from tests.support.database import recreate_database, upgrade

REPO_ROOT = Path(__file__).resolve().parents[1]
API_DIR = REPO_ROOT / "api"
LOG_DIR = REPO_ROOT / ".e2e-stack"

DEFAULT_DATABASE_URL = "postgresql://localhost:5432/first_paycheck_e2e"
# Away from the ports `make dev` (8000, 3000) and `pnpm e2e` (3100) use.
DEFAULT_API_PORT = 8247
DEFAULT_AUTH_PORT = 8248
DEFAULT_WEB_PORT = 3247
DEFAULT_COMMAND = ("pnpm", "--dir", "web", "e2e")

HOST = "127.0.0.1"
TOKEN_TTL_SECONDS = 3600
HEALTH_TIMEOUT_SECONDS = 120.0
POLL_SECONDS = 0.25
STOP_GRACE_SECONDS = 30.0

# Any non-empty value: the stand-in does not check it, but the web treats
# Supabase as configured only when both NEXT_PUBLIC_SUPABASE_* are set.
PUBLISHABLE_KEY = "sb_publishable_e2e_local"

# Secrets only the API may hold; the Playwright command never inherits them.
_API_ONLY = ("PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_TOKEN_KEY", "ANTHROPIC_API_KEY")


# ---------------------------------------------------------------- fixture users


@dataclass(frozen=True)
class FixtureUser:
    id: uuid.UUID
    email: str
    password: str = field(repr=False)


class FixtureUsers(NamedTuple):
    """``shared``: the e2e user every saved-session spec uses (E2E_USER_*).
    ``alpha``: a fresh account for ``alpha.spec.ts``, which signs in itself."""

    shared: FixtureUser
    alpha: FixtureUser


def fixture_users() -> FixtureUsers:
    """The two synthetic users, with passwords made for this run."""
    return FixtureUsers(
        shared=FixtureUser(
            uuid.UUID("00000000-0000-4000-8000-0000000000e2"),
            "e2e@example.com",
            secrets.token_urlsafe(24),
        ),
        alpha=FixtureUser(
            uuid.UUID("00000000-0000-4000-8000-0000000000a1"),
            "alpha@example.com",
            secrets.token_urlsafe(24),
        ),
    )


# ---------------------------------------------------------------- Supabase Auth stand-in


class AuthError(Exception):
    """An error response in Supabase Auth's shape (``error_code`` and ``msg``)."""

    def __init__(self, status: HTTPStatus, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


class FakeSupabaseAuth:
    """The Supabase Auth routes supabase-js calls, for synthetic fixture users.

    Tokens are shaped like Supabase's (ES256 with a ``kid``, audience
    ``authenticated``, issuer ``<url>/auth/v1``), so the API verifies them with
    its production code path. Refresh tokens are single use. Sign-up and email
    links are refused: fixture users are made by the harness.
    """

    def __init__(
        self, users: Iterable[FixtureUser], *, port: int, log: TextIO | None = None
    ) -> None:
        self._users = {user.email.lower(): user for user in users}
        self._key = ec.generate_private_key(ec.SECP256R1())
        self._kid = f"e2e-{secrets.token_hex(4)}"
        self._refresh_tokens: dict[str, FixtureUser] = {}
        self._lock = threading.Lock()
        self._log = log
        self._server = _AuthHTTPServer((HOST, port), _AuthHandler, self)
        self._thread: threading.Thread | None = None

    @property
    def url(self) -> str:
        """The project URL (NEXT_PUBLIC_SUPABASE_URL and the API's SUPABASE_URL)."""
        return f"http://{HOST}:{self._server.server_address[1]}"

    @property
    def issuer(self) -> str:
        return f"{self.url}/auth/v1"

    def start(self) -> None:
        self._thread = threading.Thread(
            target=self._server.serve_forever, name="fake-supabase-auth", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        if self._thread is not None:
            self._thread.join()

    def jwks(self) -> dict[str, Any]:
        jwk = json.loads(ECAlgorithm.to_jwk(self._key.public_key()))
        jwk.update({"kid": self._kid, "alg": "ES256", "use": "sig", "key_ops": ["verify"]})
        return {"keys": [jwk]}

    def password_grant(self, body: Mapping[str, Any]) -> dict[str, Any]:
        user = self._users.get(str(body.get("email", "")).strip().lower())
        password = body.get("password")
        if (
            user is None
            or not isinstance(password, str)
            or not secrets.compare_digest(password.encode(), user.password.encode())
        ):
            raise AuthError(
                HTTPStatus.BAD_REQUEST, "invalid_credentials", "Invalid login credentials"
            )
        return self._session(user)

    def refresh_grant(self, body: Mapping[str, Any]) -> dict[str, Any]:
        token = str(body.get("refresh_token", ""))
        with self._lock:
            user = self._refresh_tokens.pop(token, None)
        if user is None:
            raise AuthError(
                HTTPStatus.BAD_REQUEST, "refresh_token_not_found", "Invalid Refresh Token"
            )
        return self._session(user)

    def user_for(self, authorization: str | None) -> dict[str, Any]:
        token = (authorization or "").removeprefix("Bearer ").strip()
        try:
            claims = jwt.decode(
                token,
                self._key.public_key(),
                algorithms=["ES256"],
                audience="authenticated",
                issuer=self.issuer,
            )
        except jwt.PyJWTError as exc:
            raise AuthError(HTTPStatus.UNAUTHORIZED, "bad_jwt", "invalid JWT") from exc
        user = self._users.get(str(claims.get("email", "")).lower())
        if user is None or str(user.id) != claims.get("sub"):
            raise AuthError(HTTPStatus.UNAUTHORIZED, "bad_jwt", "invalid JWT")
        return _user_json(user)

    def log(self, line: str) -> None:
        if self._log is not None:
            self._log.write(line + "\n")
            self._log.flush()

    def _session(self, user: FixtureUser) -> dict[str, Any]:
        now = int(time.time())
        claims = {
            "sub": str(user.id),
            "aud": "authenticated",
            "iss": self.issuer,
            "iat": now,
            "exp": now + TOKEN_TTL_SECONDS,
            "role": "authenticated",
            "email": user.email,
            "phone": "",
            "app_metadata": {"provider": "email", "providers": ["email"]},
            "user_metadata": {},
            "aal": "aal1",
            "amr": [{"method": "password", "timestamp": now}],
            "session_id": str(uuid.uuid4()),
            "is_anonymous": False,
        }
        access_token = jwt.encode(claims, self._key, algorithm="ES256", headers={"kid": self._kid})
        refresh_token = secrets.token_urlsafe(24)
        with self._lock:
            self._refresh_tokens[refresh_token] = user
        return {
            "access_token": access_token,
            "token_type": "bearer",
            "expires_in": TOKEN_TTL_SECONDS,
            "expires_at": now + TOKEN_TTL_SECONDS,
            "refresh_token": refresh_token,
            "user": _user_json(user),
        }


def _user_json(user: FixtureUser) -> dict[str, Any]:
    created = "2026-01-01T00:00:00Z"
    return {
        "id": str(user.id),
        "aud": "authenticated",
        "role": "authenticated",
        "email": user.email,
        "email_confirmed_at": created,
        "confirmed_at": created,
        "phone": "",
        "app_metadata": {"provider": "email", "providers": ["email"]},
        "user_metadata": {},
        "identities": [],
        "created_at": created,
        "updated_at": created,
        "is_anonymous": False,
    }


class _AuthHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self,
        address: tuple[str, int],
        handler: type[BaseHTTPRequestHandler],
        auth: FakeSupabaseAuth,
    ) -> None:
        self.auth = auth
        super().__init__(address, handler)


class _AuthHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    @property
    def auth(self) -> FakeSupabaseAuth:
        return cast(_AuthHTTPServer, self.server).auth

    def do_OPTIONS(self) -> None:
        # CORS preflight: the browser client sends apikey, authorization and
        # x-client-info headers from the web origin.
        requested = self.headers.get("Access-Control-Request-Headers")
        self._respond(
            HTTPStatus.NO_CONTENT,
            None,
            {
                "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": requested
                or "authorization, apikey, content-type, x-client-info",
                "Access-Control-Max-Age": "600",
            },
        )

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        try:
            if path == "/auth/v1/.well-known/jwks.json":
                self._respond(HTTPStatus.OK, self.auth.jwks())
            elif path == "/auth/v1/user":
                self._respond(HTTPStatus.OK, self.auth.user_for(self.headers.get("Authorization")))
            else:
                raise AuthError(HTTPStatus.NOT_FOUND, "not_found", "Not found")
        except AuthError as error:
            self._error(error)

    def do_POST(self) -> None:
        parts = urlsplit(self.path)
        try:
            body = self._json_body()
            if parts.path == "/auth/v1/token":
                grant = parse_qs(parts.query).get("grant_type", [""])[0]
                if grant == "password":
                    self._respond(HTTPStatus.OK, self.auth.password_grant(body))
                elif grant == "refresh_token":
                    self._respond(HTTPStatus.OK, self.auth.refresh_grant(body))
                else:
                    raise AuthError(
                        HTTPStatus.BAD_REQUEST, "validation_failed", "Unsupported grant type"
                    )
            elif parts.path == "/auth/v1/logout":
                # Tokens are stateless here; the client clears its own session.
                self._respond(HTTPStatus.NO_CONTENT, None)
            elif parts.path == "/auth/v1/signup":
                raise AuthError(
                    HTTPStatus.UNPROCESSABLE_ENTITY, "signup_disabled", "Signups not allowed"
                )
            elif parts.path == "/auth/v1/otp":
                raise AuthError(
                    HTTPStatus.UNPROCESSABLE_ENTITY, "otp_disabled", "Email links are off"
                )
            else:
                raise AuthError(HTTPStatus.NOT_FOUND, "not_found", "Not found")
        except AuthError as error:
            self._error(error)

    def _json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length == 0:
            return {}
        try:
            data = json.loads(self.rfile.read(length))
        except ValueError as exc:
            raise AuthError(HTTPStatus.BAD_REQUEST, "bad_json", "Invalid JSON") from exc
        return data if isinstance(data, dict) else {}

    def _error(self, error: AuthError) -> None:
        self._respond(
            error.status,
            {"code": int(error.status), "error_code": error.code, "msg": error.message},
        )

    def _respond(
        self,
        status: HTTPStatus,
        payload: Mapping[str, Any] | None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        body = b"" if payload is None else json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        if payload is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        # The request line and status only (never bodies, which hold passwords).
        self.auth.log(f"{datetime.now(UTC).isoformat()} {format % args}")


# ---------------------------------------------------------------- configuration


@dataclass(frozen=True)
class StackConfig:
    database_url: str
    api_port: int
    auth_port: int
    web_port: int
    plaid_client_id: str | None = field(default=None, repr=False)
    plaid_secret: str | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        name = make_url(self.database_url).database or ""
        if "e2e" not in name:
            raise ValueError(
                f"E2E_DATABASE_URL names {name!r}; the harness drops and recreates it, "
                "so its name must contain 'e2e'"
            )

    @classmethod
    def from_env(cls, env: Mapping[str, str], dotenv: Mapping[str, str | None]) -> StackConfig:
        """Settings from the environment; Plaid keys may also come from the repo's .env."""

        def plaid(name: str) -> str | None:
            value = env.get(name) or dotenv.get(name) or ""
            return value.strip() or None

        return cls(
            database_url=env.get("E2E_DATABASE_URL") or DEFAULT_DATABASE_URL,
            api_port=int(env.get("E2E_API_PORT") or DEFAULT_API_PORT),
            auth_port=int(env.get("E2E_AUTH_PORT") or DEFAULT_AUTH_PORT),
            web_port=int(env.get("E2E_PORT") or DEFAULT_WEB_PORT),
            plaid_client_id=plaid("PLAID_CLIENT_ID"),
            plaid_secret=plaid("PLAID_SECRET"),
        )

    @property
    def plaid_configured(self) -> bool:
        return bool(self.plaid_client_id and self.plaid_secret)

    @property
    def api_url(self) -> str:
        return f"http://{HOST}:{self.api_port}"

    @property
    def web_origin(self) -> str:
        # Playwright's baseURL (playwright.config.ts).
        return f"http://localhost:{self.web_port}"


def _settings_variables() -> set[str]:
    """Every environment variable the API's Settings reads."""
    names: set[str] = set()
    for name, info in Settings.model_fields.items():
        names.add(name.upper())
        if isinstance(info.validation_alias, AliasChoices):
            names.update(str(choice).upper() for choice in info.validation_alias.choices)
    return names


def api_environment(
    config: StackConfig,
    *,
    auth_url: str,
    app_api_url: str,
    token_key: str,
    inherited: Mapping[str, str],
) -> dict[str, str]:
    """The API's and worker's environment: nothing from the developer's settings."""
    env = {key: value for key, value in inherited.items() if key not in _settings_variables()}
    env.update(
        {
            # APP_ENV=test makes Settings skip the .env file, so no hosted
            # database, key or DSN can leak in; everything is set here.
            "APP_ENV": "test",
            "LOG_LEVEL": "INFO",
            "DATABASE_URL": app_api_url,
            "DATABASE_URL_PRIVILEGED": config.database_url,
            "TEST_DATABASE_URL": "",
            "SUPABASE_URL": auth_url,
            "SUPABASE_JWKS_URL": "",
            "SUPABASE_JWKS": "",
            "CORS_ORIGINS": config.web_origin,
            "CORS_ORIGIN_REGEX": "",
            "PLAID_CLIENT_ID": config.plaid_client_id or "",
            "PLAID_SECRET": config.plaid_secret or "",
            "PLAID_ENV": "sandbox",
            "PLAID_WEBHOOK_URL": "",
            "PLAID_TOKEN_KEY": token_key,
            "ANTHROPIC_API_KEY": "",
            "LLM_FAKE": "true",
            "SENTRY_DSN": "",
            # app.serve: uvicorn's port and one worker process.
            "PORT": str(config.api_port),
            "WEB_CONCURRENCY": "1",
        }
    )
    return env


def playwright_environment(
    config: StackConfig,
    *,
    auth_url: str,
    users: FixtureUsers,
    inherited: Mapping[str, str],
) -> dict[str, str]:
    """The command's environment: the web points at the stack and signs in to it."""
    env = {key: value for key, value in inherited.items() if key not in _API_ONLY}
    env.update(
        {
            "E2E_API_URL": config.api_url,
            "E2E_PORT": str(config.web_port),
            "NEXT_PUBLIC_SUPABASE_URL": auth_url,
            "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY": PUBLISHABLE_KEY,
            "E2E_USER_EMAIL": users.shared.email,
            "E2E_USER_PASSWORD": users.shared.password,
            "NEXT_PUBLIC_E2E_USER_EMAIL": users.shared.email,
            "E2E_ALPHA_USER_EMAIL": users.alpha.email,
            "E2E_ALPHA_USER_PASSWORD": users.alpha.password,
            "E2E_PLAID_SANDBOX": "1" if config.plaid_configured else "0",
        }
    )
    return env


# ---------------------------------------------------------------- database


def psycopg_url(url: str) -> str:
    """``url`` with the psycopg 3 driver, which the API and Alembic use."""
    return make_url(url).set(drivername="postgresql+psycopg").render_as_string(hide_password=False)


def _admin_url(url: str) -> str:
    return make_url(psycopg_url(url)).set(database="postgres").render_as_string(hide_password=False)


def drop_database(url: str) -> None:
    drop_named_database(_admin_url(url), psycopg_url(url))


def prepare_database(url: str, users: Iterable[FixtureUser]) -> str:
    """Recreate, migrate and seed the database, add ``users``; returns app_api's URL."""
    url = psycopg_url(url)
    recreate_database(_admin_url(url), url)
    engine = create_engine(url)
    try:
        with engine.begin() as connection:
            ensure_auth_shim(connection)
        upgrade(url, "head")
        load_seed_data(engine)
        # Characters from token_urlsafe only, so it is safe inside the literal
        # (ALTER ROLE takes no bind parameters).
        password = secrets.token_urlsafe(24)
        with engine.begin() as connection:
            connection.execute(text(f"ALTER ROLE app_api WITH LOGIN PASSWORD '{password}'"))
            for user in users:
                connection.execute(
                    text("INSERT INTO auth.users (id, email) VALUES (:id, :email)"),
                    {"id": user.id, "email": user.email},
                )
    finally:
        engine.dispose()
    return (
        make_url(url)
        .set(username="app_api", password=password)
        .render_as_string(hide_password=False)
    )


# ---------------------------------------------------------------- processes


def _port_in_use(port: int) -> bool:
    try:
        with socket.create_connection(("localhost", port), timeout=0.5):
            return True
    except OSError:
        return False


def _wait_for_health(url: str, process: subprocess.Popen[bytes], log_path: Path) -> None:
    deadline = time.monotonic() + HEALTH_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"the API exited with {process.returncode}; see {log_path}")
        connection = http.client.HTTPConnection(urlsplit(url).netloc, timeout=2)
        try:
            connection.request("GET", "/health")
            if connection.getresponse().status == HTTPStatus.OK:
                return
        except OSError:
            pass  # not listening yet
        finally:
            connection.close()
        time.sleep(POLL_SECONDS)
    raise RuntimeError(f"the API did not answer /health in time; see {log_path}")


def _stop(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    # app.serve forwards SIGTERM to uvicorn and the worker and waits for both.
    process.terminate()
    try:
        process.wait(timeout=STOP_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


@contextlib.contextmanager
def running_stack(config: StackConfig, log_dir: Path = LOG_DIR) -> Iterator[dict[str, str]]:
    """Start the stack; yields the environment for the command that tests it."""
    busy = [
        port for port in (config.api_port, config.auth_port, config.web_port) if _port_in_use(port)
    ]
    if busy:
        # Playwright would reuse a web server already on E2E_PORT, built with
        # someone else's settings; a busy API or auth port would mean the same.
        raise RuntimeError(f"ports already in use: {busy}; stop what is on them first")

    log_dir.mkdir(parents=True, exist_ok=True)
    users = fixture_users()
    print(f"e2e stack: preparing {make_url(config.database_url).database}", flush=True)
    app_api_url = prepare_database(config.database_url, users)

    with (
        (log_dir / "auth.log").open("w", encoding="utf-8") as auth_log,
        (log_dir / "api.log").open("wb") as api_log,
    ):
        auth = FakeSupabaseAuth(users, port=config.auth_port, log=auth_log)
        auth.start()
        try:
            env = api_environment(
                config,
                auth_url=auth.url,
                app_api_url=app_api_url,
                token_key=Fernet.generate_key().decode(),
                inherited=os.environ,
            )
            process = subprocess.Popen(
                [sys.executable, "-m", "app.serve"],
                cwd=API_DIR,
                env=env,
                stdout=api_log,
                stderr=subprocess.STDOUT,
            )
            try:
                _wait_for_health(config.api_url, process, log_dir / "api.log")
                plaid = "with" if config.plaid_configured else "without"
                print(
                    f"e2e stack: API {config.api_url}, auth {auth.url}, "
                    f"web {config.web_origin}, {plaid} the Plaid sandbox",
                    flush=True,
                )
                yield playwright_environment(
                    config, auth_url=auth.url, users=users, inherited=os.environ
                )
            finally:
                _stop(process)
        finally:
            auth.stop()


def _raise_on_sigterm() -> None:
    """Turn SIGTERM into SystemExit so the stack's ``finally`` blocks run."""

    def handler(signum: int, frame: object) -> None:
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, handler)


def _print_exports(env: Mapping[str, str]) -> None:
    names = sorted(
        key for key in env if key.startswith(("E2E_", "NEXT_PUBLIC_SUPABASE_", "NEXT_PUBLIC_E2E_"))
    )
    print("e2e stack is up. In another shell (synthetic users, valid for this run only):")
    for name in names:
        print(f"  export {name}={env[name]}")
    print("  pnpm --dir web e2e")
    print("Ctrl-C stops it.", flush=True)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else None)
    sub = parser.add_subparsers(dest="action", required=True)
    run = sub.add_parser("run", help="start the stack, run a command against it, stop it")
    run.add_argument(
        "command",
        nargs=argparse.REMAINDER,
        help=f"after --; default: {' '.join(DEFAULT_COMMAND)}",
    )
    sub.add_parser("up", help="start the stack and wait for Ctrl-C")
    args = parser.parse_args(argv)

    config = StackConfig.from_env(os.environ, dotenv_values(REPO_ROOT / ".env"))
    _raise_on_sigterm()
    try:
        with running_stack(config) as env:
            if args.action == "up":
                _print_exports(env)
                threading.Event().wait()
                return 0
            command = [part for part in args.command if part != "--"] or list(DEFAULT_COMMAND)
            return subprocess.call(command, cwd=REPO_ROOT, env=env)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
