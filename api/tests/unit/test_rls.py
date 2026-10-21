"""The SQL that ``db.rls.enable_rls`` applies to a table."""

from __future__ import annotations

import pytest

from db.rls import rls_statements


def test_default_statements() -> None:
    assert rls_statements("notes") == [
        "ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY",
        "ALTER TABLE public.notes FORCE ROW LEVEL SECURITY",
        "REVOKE ALL ON public.notes FROM PUBLIC, anon, authenticated",
        "CREATE POLICY notes_owner ON public.notes AS PERMISSIVE FOR ALL TO authenticated "
        "USING (user_id = (SELECT public.current_user_id())) "
        "WITH CHECK (user_id = (SELECT public.current_user_id()))",
        "GRANT SELECT, INSERT, UPDATE, DELETE ON public.notes TO authenticated",
    ]


def test_privileges_and_owner_column_are_configurable() -> None:
    statements = rls_statements("decisions", privileges=("SELECT", "INSERT"), owner_column="owner")
    assert statements[-1] == "GRANT SELECT, INSERT ON public.decisions TO authenticated"
    assert "USING (owner = (SELECT public.current_user_id()))" in statements[3]


@pytest.mark.parametrize("name", ["Notes", "notes; DROP TABLE x", "1notes", "", "a.b"])
def test_identifiers_are_validated(name: str) -> None:
    with pytest.raises(ValueError, match="identifier"):
        rls_statements(name)


def test_owner_column_is_validated() -> None:
    with pytest.raises(ValueError, match="identifier"):
        rls_statements("notes", owner_column="user_id OR true")


@pytest.mark.parametrize("privileges", [(), ("SELECT", "TRUNCATE"), ("select",)])
def test_privileges_are_validated(privileges: tuple[str, ...]) -> None:
    with pytest.raises(ValueError, match="privilege"):
        rls_statements("notes", privileges=privileges)
