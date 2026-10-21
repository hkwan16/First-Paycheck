"""Row-level security for user-owned tables.

Every user-owned table gets the same treatment, applied from its migration
with ``enable_rls("table")``:

* RLS enabled and forced, so even the table owner is filtered;
* all privileges revoked from PUBLIC, ``anon`` and ``authenticated`` (Supabase
  grants broad default privileges), then the listed ones granted back to
  ``authenticated``;
* one owner policy: a row is visible and writable only when its owner column
  equals ``public.current_user_id()`` (the JWT ``sub``).

The helper lives here rather than in ``alembic/`` so migrations and tests can
import it as ``db.rls``.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

_IDENTIFIER = re.compile(r"^[a-z_][a-z0-9_]*$")
_ALLOWED_PRIVILEGES = ("SELECT", "INSERT", "UPDATE", "DELETE")
DEFAULT_PRIVILEGES: tuple[str, ...] = _ALLOWED_PRIVILEGES


def _identifier(name: str) -> str:
    if not _IDENTIFIER.fullmatch(name):
        raise ValueError(f"{name!r} is not a plain lowercase SQL identifier")
    return name


def rls_statements(
    table: str,
    *,
    owner_column: str = "user_id",
    privileges: Sequence[str] = DEFAULT_PRIVILEGES,
    schema: str = "public",
) -> list[str]:
    """The SQL that puts ``schema.table`` under the owner policy."""
    qualified = f"{_identifier(schema)}.{_identifier(table)}"
    column = _identifier(owner_column)
    if not privileges or any(p not in _ALLOWED_PRIVILEGES for p in privileges):
        raise ValueError(f"privileges must be a non-empty subset of {_ALLOWED_PRIVILEGES}")
    owner = f"{column} = (SELECT public.current_user_id())"
    return [
        f"ALTER TABLE {qualified} ENABLE ROW LEVEL SECURITY",
        f"ALTER TABLE {qualified} FORCE ROW LEVEL SECURITY",
        f"REVOKE ALL ON {qualified} FROM PUBLIC, anon, authenticated",
        f"CREATE POLICY {table}_owner ON {qualified} AS PERMISSIVE FOR ALL TO authenticated "
        f"USING ({owner}) WITH CHECK ({owner})",
        f"GRANT {', '.join(privileges)} ON {qualified} TO authenticated",
    ]


def enable_rls(
    table: str,
    *,
    owner_column: str = "user_id",
    privileges: Sequence[str] = DEFAULT_PRIVILEGES,
    schema: str = "public",
) -> None:
    """Apply ``rls_statements`` inside the running Alembic migration."""
    from alembic import op

    for statement in rls_statements(
        table, owner_column=owner_column, privileges=privileges, schema=schema
    ):
        op.execute(statement)
