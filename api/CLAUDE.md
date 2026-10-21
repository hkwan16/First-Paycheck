# api/

FastAPI backend and background worker. Python 3.12, managed by uv from the repo
root (`uv sync --all-packages`). `api/` is the import root: `app`, `calc`, `db`,
`jobs`, `llm`, ... are top-level packages (add new ones to `pyproject.toml`
`[tool.hatch.build.targets.wheel] packages`).

## Layout

```
app/        main.py (create_app), config.py (Settings), auth.py (JWT), db.py (engines,
            user_session), deps.py (UserSession, DbBind), errors.py, openapi.py, routers/
calc/       calculators: f(Input) -> Result, Pydantic models, integer cents, Decimal rates
db/         models.py (Base), rls.py (enable_rls), enums.py, seed/ (load.py, data files)
alembic/    env.py, versions/NNNN_name.py
sync/       SyncProvider protocol, pipeline, Plaid and CSV providers, categorize, recurring
ingest/     store (document_blobs), reader, OCR, redaction, chunking
llm/        gateway.py (the only anthropic import), schemas.py, cost.py, prompts/<name>/vN.md
retrieval/  IRS citations, benefits full-text search
verify/     number and citation checks for explanations
jobs/       queue.py, worker.py, scheduler.py, registry.py, handlers/
checkin/    engine and one pure function per finding kind
export/     plan PDF (WeasyPrint, worker only), calendar
tests/      unit/ (no DB, no network), integration/ (real Postgres), support/
```

## Request lifecycle and RLS

1. `CurrentUser` (`app/auth.py`) verifies the Supabase access token with
   `PyJWKClient` against the project JWKS: ES256 or RS256 only, audience
   `authenticated`, the project issuer, 30 s leeway. Failures are 401; a JWKS
   outage is 503 (the token may be fine).
2. `UserSession` (`app/deps.py`) opens one transaction on the `app_api` engine
   and runs `SET LOCAL ROLE authenticated` plus
   `set_config('request.jwt.claims', <claims>, true)`, so `auth.uid()` and every
   policy see the user. Both are transaction-local: commit or rollback returns a
   clean pooled connection. The dependency uses `scope="function"`, so the
   commit happens before the response is sent.
3. Job handlers have no JWT: they use `user_session_for(user_id)`.

Rules:

- Routers never import `app.db` or create engines; they take `UserSession`.
  `tests/unit/test_boundaries.py` enforces this and the `calc/` and `anthropic`
  boundaries.
- `get_privileged_engine()` (the `postgres` role) is for `jobs/queue.py`
  (dequeue across users), `jobs/scheduler.py` and Alembic only. Cross-user SQL
  outside those places goes through a reviewed `SECURITY DEFINER` function.
- A row owned by someone else is invisible under RLS, so the route returns 404.
- `app_api` is `NOINHERIT` and owns nothing; without the role switch it cannot
  read user data. Turn off Supabase's Data API exposure of `public` (Project
  Settings, API): `authenticated` holds table grants, so PostgREST would
  otherwise let a signed-in user write rows past the API's validation.

## Database and migrations

- Every user-owned table has `user_id uuid NOT NULL REFERENCES auth.users(id)
  ON DELETE CASCADE` and gets `enable_rls("table")` (from `db.rls`) in the
  migration that creates it: RLS enabled and forced, grants reset, one owner
  policy on `public.current_user_id()`.
- Money columns are `bigint` named `*_cents`; Pydantic uses
  `Annotated[int, Field(strict=True)]`. Timestamps are `timestamptz` in UTC.
- New revision: `make revision id=0002_core msg="core tables"`. Hand-check
  autogenerate output; RLS, grants, triggers and functions are written by hand.
  Every revision has a working `downgrade()`.
- Migrations never create Supabase's `auth` schema; tests install a shim
  (`tests/support/auth_shim.py`) on plain Postgres.
- CI runs upgrade, downgrade to base, upgrade and `alembic check`.

## Errors and the API contract

- Raise `AppError` (or `NotFound`, `Unauthorized`); every error leaves as
  `{"error": {"code", "message"}}`. Document error statuses on a route with
  `responses=error_responses(404, 422)`.
- Operation ids are route function names. After a route or schema change run
  `make types` and commit `api/openapi.json`; a unit test and CI fail on drift.

## LLM gateway (from M1)

- `llm/gateway.py` is the only module that imports `anthropic`. It uses
  `client.messages.parse` with a Pydantic schema, a cached system prompt,
  checks `stop_reason == "refusal"` before reading output, writes one
  `llm_calls` row per call and refuses calls past the user's daily budget.
- `LLM_FAKE=true` swaps in `FakeGateway` with canned fixtures; every API and
  worker test runs with it. Live calls are marked `llm_live` and never run by
  default.
- Model ids come from settings (`LLM_MODEL_*`), never literals in code.

## Testing

- `make test-api`. Unit tests need nothing; integration tests need
  `TEST_DATABASE_URL` (a disposable local Postgres) and are skipped without it,
  except in CI where a missing URL fails the run.
- `tests/conftest.py` pins the environment (`APP_ENV=test` ignores `.env`),
  migrates the test database once, wraps each test in a transaction that is
  rolled back, inserts `user_a` and `user_b` into `auth.users`, and provides
  `client_as(user)` (a TestClient sending a signed ES256 JWT) plus `app_api_url`
  for tests that must connect exactly as production does.
- Calculator tests come from the spec's hand-worked examples, plus Hypothesis
  properties (`derandomize=True` in CI).
- Marks: `plaid_sandbox` and `llm_live` call real services and are excluded by
  default (`-m "not plaid_sandbox and not llm_live"`).
- Coverage gate in CI: 85%.

## Running

```
cd api && uv run uvicorn app.main:app --reload     # or `make dev` from the root
cd api && uv run python -m jobs.worker              # or `make worker`
cd api && uv run alembic upgrade head               # or `make migrate`
docker build -f api/Dockerfile -t first-paycheck-api .   # from the repo root
```
