"""The SQL that ``db.rls`` applies to a table and to a function."""

from __future__ import annotations

import pytest

from db.rls import function_statements, rls_statements


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


def test_function_statements_revoke_the_supabase_defaults_then_grant_back() -> None:
    assert function_statements("decision_is_mine(uuid)", execute=["authenticated"]) == [
        "REVOKE ALL ON FUNCTION public.decision_is_mine(uuid) FROM PUBLIC, anon, authenticated",
        "GRANT EXECUTE ON FUNCTION public.decision_is_mine(uuid) TO authenticated",
    ]


def test_trigger_functions_get_no_grant() -> None:
    assert function_statements("decisions_immutable()") == [
        "REVOKE ALL ON FUNCTION public.decisions_immutable() FROM PUBLIC, anon, authenticated",
    ]


@pytest.mark.parametrize(
    "signature", ["decision_is_mine", "Mine(uuid)", "f(uuid); DROP TABLE x", "public.f()", ""]
)
def test_function_signatures_are_validated(signature: str) -> None:
    with pytest.raises(ValueError, match="signature"):
        function_statements(signature)


def test_function_grantees_are_validated() -> None:
    with pytest.raises(ValueError, match="identifier"):
        function_statements("f()", execute=["authenticated; DROP ROLE x"])
