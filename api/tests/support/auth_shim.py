"""A minimal stand-in for Supabase's ``auth`` schema on a plain Postgres.

Supabase provides ``auth.users``, ``auth.uid()`` and the ``anon`` and
``authenticated`` roles. Migrations depend on them but never create them; the
test suite (and the CI migrations job, through this module) installs this shim
when the ``auth`` schema is missing. ``auth.uid()`` mirrors Supabase's
definition: the ``sub`` claim from ``request.jwt.claims``.

Run ``python -m tests.support.auth_shim [DATABASE_URL]`` from ``api/`` to
install it into TEST_DATABASE_URL (or the given URL).
"""

from __future__ import annotations

import sys

from sqlalchemy import Connection, create_engine, text

from app.config import get_settings

_ROLES = """
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
END
$$
"""

_SCHEMA = (
    "CREATE SCHEMA auth",
    "CREATE TABLE auth.users (id uuid PRIMARY KEY, email text UNIQUE)",
    """
    CREATE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
      SELECT nullif(
        coalesce(
          nullif(current_setting('request.jwt.claim.sub', true), ''),
          nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
        ),
        ''
      )::uuid
    $$
    """,
    "GRANT USAGE ON SCHEMA auth TO anon, authenticated",
    "GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated",
)


def ensure_auth_shim(connection: Connection) -> bool:
    """Create the shim if the ``auth`` schema is missing. Returns True when created.

    Roles are cluster-wide, so they are created on their own when missing even
    if this database already has the schema.
    """
    connection.execute(text(_ROLES))
    has_auth = connection.execute(
        text("SELECT EXISTS (SELECT FROM pg_namespace WHERE nspname = 'auth')")
    ).scalar_one()
    if has_auth:
        return False
    for statement in _SCHEMA:
        connection.execute(text(statement))
    return True


def main(argv: list[str]) -> int:
    url = argv[1] if len(argv) > 1 else get_settings().test_database_url
    if not url:
        sys.stderr.write("TEST_DATABASE_URL is not set and no URL was given\n")
        return 2
    engine = create_engine(url)
    try:
        with engine.begin() as connection:
            created = ensure_auth_shim(connection)
    finally:
        engine.dispose()
    sys.stdout.write("auth shim created\n" if created else "auth schema already present\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
