"""Migrations run forward and back on an empty database and match the models."""

from __future__ import annotations

import json
import uuid
from typing import Any

from sqlalchemy import Engine, text

from app.db import current_alembic_revision, user_session_for
from db.seed.load import load_category_rules, read_seed_rules
from sync.categorize import categorize_user
from tests.support.database import check, downgrade, head_revision, upgrade


def revision(engine: Engine) -> str | None:
    with engine.connect() as connection:
        return current_alembic_revision(connection)


def function_exists(engine: Engine, signature: str) -> bool:
    with engine.connect() as connection:
        return bool(
            connection.execute(
                text("SELECT to_regprocedure(:signature) IS NOT NULL"), {"signature": signature}
            ).scalar_one()
        )


def test_upgrade_downgrade_upgrade_then_check(scratch_database: tuple[str, Engine]) -> None:
    url, engine = scratch_database

    upgrade(url, "head")
    assert revision(engine) == head_revision()
    assert function_exists(engine, "public.current_user_id()")

    downgrade(url, "base")
    assert revision(engine) is None
    assert not function_exists(engine, "public.current_user_id()")

    upgrade(url, "head")
    assert revision(engine) == head_revision()
    check(url)  # raises when the models and the schema disagree


def test_0001_sets_up_the_app_api_role(scratch_database: tuple[str, Engine]) -> None:
    url, engine = scratch_database
    upgrade(url, "head")
    with engine.connect() as connection:
        role = connection.execute(
            text(
                "SELECT rolinherit, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_api'"
            )
        ).one()
        assert role == (False, False, False)
        can_switch = connection.execute(
            text("SELECT pg_has_role('app_api', 'authenticated', 'SET')")
        ).scalar_one()
        assert can_switch
        reads_version = connection.execute(
            text("SELECT has_table_privilege('app_api', 'public.alembic_version', 'SELECT')")
        ).scalar_one()
        assert reads_version


def tables_granted_to(engine: Engine, *roles: str) -> list[str]:
    with engine.connect() as connection:
        return list(
            connection.execute(
                text(
                    "SELECT DISTINCT table_name FROM information_schema.role_table_grants "
                    "WHERE table_schema = 'public' AND grantee = ANY(:roles) ORDER BY 1"
                ),
                {"roles": list(roles)},
            ).scalars()
        )


def functions_executable_by(engine: Engine, role: str) -> list[str]:
    with engine.connect() as connection:
        return list(
            connection.execute(
                text(
                    "SELECT p.oid::regprocedure::text FROM pg_proc p "
                    "JOIN pg_namespace n ON n.oid = p.pronamespace "
                    "WHERE n.nspname = 'public' "
                    "AND has_function_privilege(:role, p.oid, 'EXECUTE') ORDER BY 1"
                ),
                {"role": role},
            ).scalars()
        )


def test_supabase_api_roles_hold_only_the_grants_migrations_intend(
    scratch_database: tuple[str, Engine],
) -> None:
    """The shim copies Supabase's default grants; every object must revoke them.

    ``anon`` is the Data API role behind the publishable key, so it may hold
    nothing in ``public``. ``authenticated`` keeps the per-table grants from
    ``enable_rls`` and the two functions its own queries run, and nothing else.
    """
    url, engine = scratch_database
    upgrade(url, "head")

    assert tables_granted_to(engine, "anon", "PUBLIC") == []
    assert functions_executable_by(engine, "anon") == []

    assert "alembic_version" not in tables_granted_to(engine, "authenticated")
    assert "alembic_version" in tables_granted_to(engine, "app_api")
    assert functions_executable_by(engine, "authenticated") == [
        "current_user_id()",
        "decision_is_mine(uuid)",
        "set_updated_at()",
    ]


def test_0001_is_idempotent_when_the_role_already_exists(
    scratch_database: tuple[str, Engine],
) -> None:
    url, engine = scratch_database
    # app_api is cluster-wide and already exists from earlier runs; upgrading
    # twice from base must still succeed.
    upgrade(url, "head")
    downgrade(url, "base")
    upgrade(url, "head")
    assert revision(engine) == head_revision()


def test_current_user_id_reads_the_jwt_claims(scratch_database: tuple[str, Engine]) -> None:
    url, engine = scratch_database
    upgrade(url, "head")
    user_id = "6f1c2b8e-0000-4000-8000-000000000001"
    with engine.connect() as connection, connection.begin():
        connection.execute(
            text("SELECT set_config('request.jwt.claims', :claims, true)"),
            {"claims": f'{{"sub": "{user_id}"}}'},
        )
        assert str(connection.execute(text("SELECT public.current_user_id()")).scalar()) == user_id


def test_0008_numbers_existing_plans_in_list_order(scratch_database: tuple[str, Engine]) -> None:
    url, engine = scratch_database
    upgrade(url, "0005_checkins")
    user = "00000000-0000-4000-8000-0000000000c1"
    document = "00000000-0000-4000-8000-0000000000d1"
    plan = text(
        "INSERT INTO benefits_plans (user_id, document_id, name, kind,"
        " premium_per_period_cents, deductible_cents, oop_max_cents, coinsurance_pct,"
        " created_at) VALUES (:u, :d, :name, 'ppo', 0, 0, 0, 10, :at)"
    )
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO auth.users (id) VALUES (:u)"), {"u": user})
        connection.execute(
            text(
                "INSERT INTO documents (id, user_id, type, content_type, size_bytes)"
                " VALUES (:d, :u, 'benefits', 'application/pdf', 1)"
            ),
            {"d": document, "u": user},
        )
        for name, at, owner in [
            ("Second", "2026-10-02", document),
            ("First", "2026-10-01", document),
            ("By hand", "2026-10-03", None),
        ]:
            connection.execute(plan, {"u": user, "d": owner, "name": name, "at": at})

    upgrade(url, "head")
    with engine.connect() as connection:
        rows = connection.execute(
            text("SELECT name, position FROM benefits_plans ORDER BY name")
        ).all()
    assert [tuple(row) for row in rows] == [("By hand", 0), ("First", 0), ("Second", 1)]


def test_0012_keys_old_findings_and_maps_their_actions(
    scratch_database: tuple[str, Engine],
) -> None:
    url, engine = scratch_database
    upgrade(url, "0011_no_model_reason")
    user = "00000000-0000-4000-8000-0000000000c2"
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO auth.users (id) VALUES (:u)"), {"u": user})
        check_in = connection.execute(
            text(
                "INSERT INTO check_ins (user_id, period, triggered_by)"
                " VALUES (:u, '2026-10-01', 'schedule') RETURNING id"
            ),
            {"u": user},
        ).scalar_one()
        for action in ("acknowledged", "acted", "dismissed", None):
            connection.execute(
                text(
                    "INSERT INTO check_in_findings (user_id, check_in_id, kind, severity,"
                    " payload, user_action, user_action_at) VALUES (:u, :c, 'pay_change',"
                    " 'info', '{}', CAST(:a AS finding_action),"
                    " CASE WHEN CAST(:a AS text) IS NULL THEN NULL ELSE now() END)"
                ),
                {"u": user, "c": check_in, "a": action},
            )

    upgrade(url, "head")
    with engine.connect() as connection:
        rows = connection.execute(
            text(
                "SELECT user_action::text, key = 'pay_change:' || id::text"
                " FROM check_in_findings ORDER BY 1 NULLS LAST"
            )
        ).all()
    assert [tuple(row) for row in rows] == [
        ("dismissed", True),
        ("done", True),
        ("done", True),
        (None, True),
    ]

    downgrade(url, "0011_no_model_reason")
    with engine.connect() as connection:
        actions = connection.execute(
            text("SELECT user_action::text FROM check_in_findings ORDER BY 1 NULLS LAST")
        ).scalars()
        assert list(actions) == ["acted", "acted", "dismissed", None]


def account_kinds(engine: Engine) -> list[str]:
    """The labels of account_kind, in their sort order."""
    with engine.connect() as connection:
        return list(
            connection.execute(
                text("SELECT unnest(enum_range(NULL::public.account_kind))::text")
            ).scalars()
        )


def test_0015_adds_loan_after_credit_and_its_downgrade_maps_loans_to_credit(
    scratch_database: tuple[str, Engine],
) -> None:
    url, engine = scratch_database
    upgrade(url, "0014_delete_account_fn")
    assert account_kinds(engine) == ["checking", "savings", "credit", "investment", "retirement"]

    upgrade(url, "0015_loan_account_kind")
    assert account_kinds(engine) == [
        "checking",
        "savings",
        "credit",
        "loan",
        "investment",
        "retirement",
    ]
    user = "00000000-0000-4000-8000-0000000000c3"
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO auth.users (id) VALUES (:u)"), {"u": user})
        item = connection.execute(
            text("INSERT INTO sync_items (user_id, provider) VALUES (:u, 'csv') RETURNING id"),
            {"u": user},
        ).scalar_one()
        for name, kind in [("Card", "credit"), ("Mortgage", "loan"), ("Checking", "checking")]:
            connection.execute(
                text(
                    "INSERT INTO accounts (user_id, sync_item_id, provider_account_id, kind, name)"
                    " VALUES (:u, :i, :name, CAST(:kind AS account_kind), :name)"
                ),
                {"u": user, "i": item, "name": name, "kind": kind},
            )

    downgrade(url, "0014_delete_account_fn")
    assert account_kinds(engine) == ["checking", "savings", "credit", "investment", "retirement"]
    with engine.connect() as connection:
        rows = connection.execute(text("SELECT name, kind::text FROM accounts ORDER BY name"))
        assert [tuple(row) for row in rows] == [
            ("Card", "credit"),
            ("Checking", "checking"),
            ("Mortgage", "credit"),
        ]

    upgrade(url, "head")
    assert "loan" in account_kinds(engine)


def rule_matches(engine: Engine) -> list[str]:
    with engine.connect() as connection:
        return list(
            connection.execute(
                text("SELECT unnest(enum_range(NULL::public.rule_match))::text")
            ).scalars()
        )


def test_0016_adds_contains_and_clears_spending_labels_on_money_in(
    scratch_database: tuple[str, Engine],
) -> None:
    """Spec 003 rules 3c-4: ``contains`` after ``prefix``. The rule and LLM
    labels the old precedence gave money in with a spending category are
    cleared, and the next categorize run's rules pass labels them under the new
    precedence: the paychecks become income, the refund comes back as travel.
    User labels and every other label are kept."""
    url, engine = scratch_database
    upgrade(url, "0015_loan_account_kind")
    assert rule_matches(engine) == ["exact", "prefix"]
    user = uuid.UUID("00000000-0000-4000-8000-0000000000c4")
    paycheck = "sweetgreen inc payroll ppd id"
    rows = [
        # (id, merchant_norm, amount, category, source, after 0016, after the rules pass)
        ("paycheck by rule", paycheck, -81_000, "dining", "rule", None, "income"),
        ("paycheck by llm", paycheck, -81_000, "dining", "llm", None, "income"),
        ("paycheck by user", paycheck, -81_000, "dining", "user", "dining", "dining"),
        ("refund by rule", "united airlines", -50_000, "travel", "rule", None, "travel"),
        ("income by rule", "acme payroll", -81_000, "income", "rule", "income", "income"),
        ("transfer by llm", "zz own account", -5_000, "transfer", "llm", "transfer", "transfer"),
        ("lunch by rule", "sweetgreen", 1_450, "dining", "rule", "dining", "dining"),
        ("uncategorized", "zz unknown", -100, None, None, None, None),
    ]
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO auth.users (id) VALUES (:u)"), {"u": user})
        item = connection.execute(
            text("INSERT INTO sync_items (user_id, provider) VALUES (:u, 'csv') RETURNING id"),
            {"u": user},
        ).scalar_one()
        account = connection.execute(
            text(
                "INSERT INTO accounts (user_id, sync_item_id, provider_account_id, kind, name)"
                " VALUES (:u, :i, 'chk', 'checking', 'Checking') RETURNING id"
            ),
            {"u": user, "i": item},
        ).scalar_one()
        for name, merchant, amount, category, source, _, _ in rows:
            connection.execute(
                text(
                    "INSERT INTO transactions (user_id, account_id, provider_txn_id, posted_at,"
                    " amount_cents, merchant_raw, merchant_norm, category, category_source,"
                    " confidence) VALUES (:u, :a, :name, '2026-10-01', :amount, :merchant,"
                    " :merchant, :category, CAST(:source AS category_source),"
                    " CASE WHEN CAST(:source AS text) = 'llm' THEN 0.9 END)"
                ),
                {
                    "u": user,
                    "a": account,
                    "name": name,
                    "merchant": merchant,
                    "amount": amount,
                    "category": category,
                    "source": source,
                },
            )

    def categories() -> dict[str, str | None]:
        with engine.connect() as connection:
            return {
                row.provider_txn_id: row.category
                for row in connection.execute(
                    text("SELECT provider_txn_id, category FROM transactions")
                )
            }

    upgrade(url, "0016_rule_match_contains")
    assert rule_matches(engine) == ["exact", "prefix", "contains"]
    assert categories() == {row[0]: row[5] for row in rows}
    with engine.connect() as connection:
        cleared = connection.execute(
            text(
                "SELECT category_source, confidence FROM transactions"
                " WHERE provider_txn_id = 'paycheck by llm'"
            )
        ).one()
    assert tuple(cleared) == (None, None)

    # The next categorize run, as the user with the seed rules and no model.
    with engine.begin() as connection:
        load_category_rules(connection, read_seed_rules())
    result = categorize_user(
        user_id=user, sessions=lambda: user_session_for(user, bind=engine), labeler=None
    )
    assert result.rule_labeled == 3
    assert categories() == {row[0]: row[6] for row in rows}

    downgrade(url, "0015_loan_account_kind")
    assert rule_matches(engine) == ["exact", "prefix"]
    with engine.connect() as connection:
        payroll_rules = connection.execute(
            text("SELECT match::text FROM category_rules WHERE merchant_norm = 'payroll'")
        ).scalars()
        assert list(payroll_rules) == ["prefix"]

    upgrade(url, "head")
    assert "contains" in rule_matches(engine)


def role_rows(engine: Engine) -> tuple[str, str | None]:
    """The catalog row versions behind app_api and its membership of authenticated."""
    with engine.connect() as connection:
        role = connection.execute(
            text("SELECT xmin::text FROM pg_authid WHERE rolname = 'app_api'")
        ).scalar_one()
        member = connection.execute(
            text(
                "SELECT m.xmin::text FROM pg_auth_members m "
                "JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles g ON g.oid = m.member "
                "WHERE r.rolname = 'authenticated' AND g.rolname = 'app_api'"
            )
        ).scalar_one_or_none()
    return role, member


def test_0001_leaves_the_cluster_wide_role_alone_once_it_is_set_up(
    scratch_database: tuple[str, Engine],
) -> None:
    """Roles are shared by every database on the cluster, so two test runs (or
    two worktrees) migrate at the same time. Rewriting the role row on every
    upgrade, or revoking its membership on every downgrade, collides with
    "tuple concurrently updated"; after the first setup, 0001 must not write.
    """
    url, engine = scratch_database
    upgrade(url, "head")
    before = role_rows(engine)

    downgrade(url, "base")
    assert role_rows(engine) == before
    upgrade(url, "head")
    assert role_rows(engine) == before


def test_0020_supersedes_copies_already_confirmed_in_confirm_order(
    scratch_database: tuple[str, Engine],
) -> None:
    """Spec 005 rule 22e (issue 190): stubs stored before 0020 are superseded as
    rule 22b would have done, so each paycheck keeps its newest copy current."""
    url, engine = scratch_database
    upgrade(url, "0019_explanation_context_digest")
    user = "00000000-0000-4000-8000-0000000000c1"
    other = "00000000-0000-4000-8000-0000000000c2"
    document = text(
        "INSERT INTO documents (id, user_id, type, content_type, size_bytes, replaced_by_id,"
        " deleted_at) VALUES (:d, :u, 'pay_stub', 'application/pdf', 1, :r,"
        " CASE WHEN CAST(:r AS uuid) IS NULL THEN NULL ELSE now() END)"
    )
    stub = text(
        "INSERT INTO pay_stubs (id, user_id, document_id, employer_name, pay_date,"
        " period_start, period_end, gross_cents, net_cents, created_at)"
        " VALUES (:id, :u, :d, :employer, :pay_date, '2026-10-01', '2026-10-15',"
        " 270833, 270833, :at)"
    )
    # (stub, owner, document, replaced by, employer, pay date, confirmed at)
    rows = [
        ("a1", user, "d1", None, "Acme Corp", "2026-10-15", "2026-10-20 10:00"),
        ("a2", user, "d2", None, "ACME  corp", "2026-10-15", "2026-10-20 10:05"),
        ("a3", user, "d3", None, "Acme Corp", "2026-10-15", "2026-10-20 10:10"),
        ("b1", user, "d4", None, "Beta LLC", "2026-10-15", "2026-10-20 10:15"),
        # A typo the user replaced (d5 by d6) and confirmed with another pay date.
        ("t1", user, "d5", "d6", "Typo Co", "2026-10-13", "2026-10-21 09:00"),
        ("t2", user, "d6", None, "Typo Co", "2026-10-14", "2026-10-21 09:05"),
        ("o1", other, "d7", None, "Acme Corp", "2026-10-15", "2026-10-20 09:00"),
    ]

    def uid(name: str) -> str:
        return str(uuid.uuid5(uuid.NAMESPACE_URL, name))

    with engine.begin() as connection:
        for owner in (user, other):
            connection.execute(text("INSERT INTO auth.users (id) VALUES (:u)"), {"u": owner})
        # Documents nothing replaced first, so a replaced one can name its replacement.
        for _, owner, doc, replaced_by, *_ in sorted(rows, key=lambda row: row[3] is not None):
            connection.execute(
                document,
                {"d": uid(doc), "u": owner, "r": uid(replaced_by) if replaced_by else None},
            )
        for name, owner, doc, _, employer, pay_date, at in rows:
            connection.execute(
                stub,
                {
                    "id": uid(name),
                    "u": owner,
                    "d": uid(doc),
                    "employer": employer,
                    "pay_date": pay_date,
                    "at": f"{at}+00",
                },
            )

    upgrade(url, "head")
    with engine.connect() as connection:
        rows_after = connection.execute(
            text("SELECT id::text, superseded_by_id::text FROM pay_stubs")
        ).all()
    superseded: dict[str, str | None] = {row[0]: row[1] for row in rows_after}
    by_name = {uid(name): name for name, *_ in rows}
    assert {by_name[k]: v and by_name[v] for k, v in superseded.items()} == {
        "a1": "a2",
        "a2": "a3",
        "a3": None,
        "b1": None,
        "t1": "t2",
        "t2": None,
        "o1": None,
    }

    downgrade(url, "0019_explanation_context_digest")
    upgrade(url, "head")


def _uid(name: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"0021:{name}"))


# Spec 015's November stubs S1 and S2 (and S2b, a copy of S2), by the columns
# that differ: pay date, period, federal, 401(k), medical, net.
_STUBS = {
    "s1": ("2026-10-31", "2026-10-16", "2026-10-31", 29_776, 0, 6_250, 199_604),
    "s2": ("2026-11-15", "2026-11-01", "2026-11-15", 21_196, 5_417, 3_125, 205_892),
    "s2b": ("2026-11-15", "2026-11-01", "2026-11-15", 21_196, 5_417, 3_125, 205_892),
}
# S2 against S1, the three lines that differ (spec 015 finder row 16).
_LINES = [
    {
        "line": "federal_withholding",
        "label": "Federal tax",
        "amount_cents": 21_196,
        "previous_cents": 29_776,
        "change_cents": -8_580,
    },
    {
        "line": "retirement_contribution",
        "label": "401(k)",
        "amount_cents": 5_417,
        "previous_cents": 0,
        "change_cents": 5_417,
    },
    {
        "line": "medical_premium",
        "label": "Health premiums",
        "amount_cents": 3_125,
        "previous_cents": 6_250,
        "change_cents": -3_125,
    },
]


def _pair(stub: str) -> dict[str, object]:
    return {
        "pay_stub_id": _uid(stub),
        "pay_date": "2026-11-15",
        "previous_pay_stub_id": _uid("s1"),
        "previous_pay_date": "2026-10-31",
    }


def _deduction(stub: str, line: dict[str, object]) -> dict[str, object]:
    return {"kind": "deduction_change", "affects": None, **_pair(stub), **line}


_PAY_CHANGE: dict[str, object] = {
    "kind": "pay_change",
    "affects": "w4",
    **_pair("s2"),
    "gross_cents": 270_833,
    "previous_gross_cents": 270_833,
    "gross_change_cents": 0,
    "net_cents": 205_892,
    "previous_net_cents": 199_604,
    "net_change_cents": 6_288,
}
# Row 1's pay change, a raise to 291,667 as the finder wrote it: a kept pay
# change keeps its own figures, so these need not match the stubs' rows.
_RAISE: dict[str, object] = {
    **_PAY_CHANGE,
    "gross_cents": 291_667,
    "gross_change_cents": 20_834,
    "net_cents": 225_133,
    "net_change_cents": 25_529,
}


def _election(stub: str) -> dict[str, object]:
    return {
        "kind": "election_mismatch",
        "affects": "k401_match",
        "calculator": "k401_match",
        "pay_stub_id": _uid(stub),
        "pay_date": "2026-11-15",
        "expected_cents": 10_833,
        "actual_cents": 5_417,
        "difference_cents": -5_416,
        "elected_pct": "4.00",
        "actual_pct": "2.00",
        "plan_name": None,
    }


def _seed_0021(engine: Engine, user: str) -> None:
    """Spec 015's migration rows 1-3, one check-in each, as 0020 stored them."""
    # (finding, check-in, kind, payload, action, minute it was written and handled)
    findings: list[tuple[str, str, str, dict[str, object], str | None, int]] = [
        ("p1", "c1", "pay_change", _RAISE, "done", 0),
        ("f1", "c1", "deduction_change", _deduction("s2", _LINES[0]), "done", 1),
        ("r1", "c1", "deduction_change", _deduction("s2", _LINES[1]), "done", 2),
        ("m1", "c1", "deduction_change", _deduction("s2", _LINES[2]), None, 3),
        ("f2", "c2", "deduction_change", _deduction("s2", _LINES[0]), "dismissed", 1),
        ("r2", "c2", "deduction_change", _deduction("s2", _LINES[1]), "dismissed", 3),
        ("m2", "c2", "deduction_change", _deduction("s2", _LINES[2]), "dismissed", 2),
    ]
    # Issue 194's November: the run before the copy, then the run after it.
    for stub, minute in (("s2", 0), ("s2b", 10)):
        findings.append((f"e:{stub}", "c3", "election_mismatch", _election(stub), None, minute))
        findings.extend(
            (
                f"{line['line']}:{stub}",
                "c3",
                "deduction_change",
                _deduction(stub, line),
                None,
                minute,
            )
            for line in _LINES
        )
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO auth.users (id) VALUES (:u)"), {"u": user})
        connection.execute(
            text(
                "INSERT INTO decisions (id, user_id, calculator, inputs, result, version)"
                " VALUES (:id, :u, 'k401_match', '{}', '{}', 1)"
            ),
            {"id": _uid("k401"), "u": user},
        )
        # S2b supersedes S2 before it exists: the reference is deferred to commit.
        for name, superseded_by, day in (("s1", None, 1), ("s2", "s2b", 16), ("s2b", None, 20)):
            connection.execute(
                text(
                    "INSERT INTO documents (id, user_id, type, content_type, size_bytes)"
                    " VALUES (:d, :u, 'pay_stub', 'application/pdf', 1)"
                ),
                {"d": _uid(f"doc:{name}"), "u": user},
            )
            pay_date, start, end, federal, retirement, medical, net = _STUBS[name]
            connection.execute(
                text(
                    "INSERT INTO pay_stubs (id, user_id, document_id, employer_name, pay_date,"
                    " period_start, period_end, gross_cents, federal_withholding_cents,"
                    " social_security_cents, medicare_cents, state_tax_cents,"
                    " retirement_contribution_cents, medical_premium_cents,"
                    " other_deductions_cents, net_cents, superseded_by_id, created_at)"
                    " VALUES (:id, :u, :d, 'Acme Corp', :pay_date, :start, :end, 270833,"
                    " :federal, 16792, 3927, 9814, :retirement, :medical, 4670, :net, :by, :at)"
                ),
                {
                    "id": _uid(name),
                    "u": user,
                    "d": _uid(f"doc:{name}"),
                    "pay_date": pay_date,
                    "start": start,
                    "end": end,
                    "federal": federal,
                    "retirement": retirement,
                    "medical": medical,
                    "net": net,
                    "by": _uid(superseded_by) if superseded_by else None,
                    "at": f"2026-11-{day:02d} 09:00+00",
                },
            )
        for check_in, period in (("c1", "2026-09-01"), ("c2", "2026-10-01"), ("c3", "2026-11-01")):
            connection.execute(
                text(
                    "INSERT INTO check_ins (id, user_id, period, triggered_by)"
                    " VALUES (:id, :u, :period, 'schedule')"
                ),
                {"id": _uid(check_in), "u": user, "period": period},
            )
        for name, check_in, kind, payload, action, minute in findings:
            connection.execute(
                text(
                    "INSERT INTO check_in_findings (id, user_id, check_in_id, kind, severity, key,"
                    " decision_id, payload, user_action, user_action_at, created_at) VALUES"
                    " (:id, :u, :c, CAST(:kind AS finding_kind), 'info', :key, :decision,"
                    " CAST(:payload AS jsonb), CAST(:action AS finding_action),"
                    " CASE WHEN CAST(:action AS text) IS NULL THEN NULL ELSE CAST(:at AS"
                    " timestamptz) END, :at)"
                ),
                {
                    "id": _uid(name),
                    "u": user,
                    "c": _uid(check_in),
                    "kind": kind,
                    # The keys before issue 194 named the stub's row; any unique text will do.
                    "key": f"{kind}:{name}",
                    "decision": _uid("k401") if kind == "election_mismatch" else None,
                    "payload": json.dumps(payload),
                    "action": action,
                    "at": f"2026-11-20 09:{minute:02d}+00",
                },
            )


def _findings_of(engine: Engine, check_in: str) -> list[dict[str, Any]]:
    with engine.connect() as connection:
        rows = connection.execute(
            text(
                "SELECT id::text, kind::text, severity::text, key, payload, user_action::text,"
                " user_action_at FROM check_in_findings WHERE check_in_id = :c"
                " ORDER BY kind::text, key"
            ),
            {"c": _uid(check_in)},
        ).all()
    return [dict(row._mapping) for row in rows]


def test_0021_folds_paycheck_findings(scratch_database: tuple[str, Engine]) -> None:
    """Spec 015 rule 13a (issues 194 and 202): a stub's deduction changes join its
    pay change, and the findings a copy of the paycheck repeated become one."""
    url, engine = scratch_database
    upgrade(url, "0020_pay_stub_superseded_by")
    _seed_0021(engine, "00000000-0000-4000-8000-0000000000c3")
    paycheck_key = f"pay_change:{_uid('s2')}"

    upgrade(url, "head")

    # Row 1: the pay change keeps its row and takes its lines; one line was open.
    [one] = _findings_of(engine, "c1")
    assert (one["id"], one["key"], one["user_action"]) == (_uid("p1"), paycheck_key, None)
    assert one["payload"] == {**_RAISE, "deductions": _LINES}
    # Row 2: lines only, every one dismissed; the newest dismissal was at 9:03.
    [two] = _findings_of(engine, "c2")
    assert (two["kind"], two["severity"], two["key"]) == ("pay_change", "info", paycheck_key)
    assert two["payload"] == {**_PAY_CHANGE, "deductions": _LINES}
    assert two["user_action"] == "dismissed"
    assert two["user_action_at"].minute == 3
    # Row 3: one of each, keyed by the first copy, about the newest.
    election, paycheck = _findings_of(engine, "c3")
    assert election["id"] == _uid("e:s2b")
    assert election["key"] == f"election_mismatch:k401_match:{_uid('k401')}:{_uid('s2')}"
    assert paycheck["key"] == paycheck_key
    assert paycheck["payload"] == {**_PAY_CHANGE, **_pair("s2b"), "deductions": _LINES}
    assert (election["user_action"], paycheck["user_action"]) == (None, None)

    downgrade(url, "0020_pay_stub_superseded_by")
    lines = [str(line["line"]) for line in _LINES]
    one_back = _findings_of(engine, "c1")
    assert [(row["kind"], row["payload"].get("line")) for row in one_back] == [
        ("deduction_change", line) for line in sorted(lines)
    ] + [("pay_change", None)]
    two_back = _findings_of(engine, "c2")
    assert [(row["kind"], row["user_action"]) for row in two_back] == [
        ("deduction_change", "dismissed")
    ] * 3
    upgrade(url, "head")


# ---------------------------------------------------------------- 0022 (spec 015 rule 13b)


def _date(event: str, kind: str, due: str) -> dict[str, object]:
    return {
        "kind": "upcoming_deadline",
        "affects": "w4",
        "calendar_event_id": _uid(event),
        "calendar_kind": kind,
        "title": "A reminder",
        "due_at": due,
        "days_until": 3,
    }


def _seed_0022(engine: Engine, user: str) -> None:
    """Spec 015's migration rows 1-3 for 0022, one check-in each, as 0021 stored them."""
    # (finding, check-in, payload, action, minute written and handled)
    findings: list[tuple[str, str, dict[str, object], str | None, int]] = [
        ("w4", "d1", _date("e:w4", "w4_submit", "2026-11-06"), None, 0),
        ("v1", "d2", _date("e:v1", "election_check", "2026-11-15"), "done", 0),
        ("v2", "d2", _date("e:v2", "election_check", "2026-11-15"), None, 5),
        ("a", "d3", _date("e:a", "goal_contribution", "2026-11-15"), "done", 1),
        ("b", "d3", _date("e:b", "goal_review", "2027-02-15"), "done", 2),
    ]
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO auth.users (id) VALUES (:u)"), {"u": user})
        for check_in, period, completed in (
            ("d1", "2026-09-01", None),
            ("d2", "2026-10-01", None),
            ("d3", "2026-11-01", "2026-11-20 09:02+00"),
        ):
            connection.execute(
                text(
                    "INSERT INTO check_ins (id, user_id, period, triggered_by, status,"
                    " completed_at) VALUES (:id, :u, :period, 'schedule',"
                    " CAST(:status AS checkin_status), CAST(:completed AS timestamptz))"
                ),
                {
                    "id": _uid(check_in),
                    "u": user,
                    "period": period,
                    "status": "completed" if completed else "open",
                    "completed": completed,
                },
            )
        for name, check_in, payload, action, minute in findings:
            connection.execute(
                text(
                    "INSERT INTO check_in_findings (id, user_id, check_in_id, kind, severity, key,"
                    " payload, user_action, user_action_at, created_at) VALUES"
                    " (:id, :u, :c, 'upcoming_deadline', 'info', :key, CAST(:payload AS jsonb),"
                    " CAST(:action AS finding_action), CASE WHEN CAST(:action AS text) IS NULL"
                    " THEN NULL ELSE CAST(:at AS timestamptz) END, :at)"
                ),
                {
                    "id": _uid(name),
                    "u": user,
                    "c": _uid(check_in),
                    # Before 0022 the key named the event's row.
                    "key": f"upcoming_deadline:{payload['calendar_event_id']}",
                    "payload": json.dumps(payload),
                    "action": action,
                    "at": f"2026-11-20 09:{minute:02d}+00",
                },
            )


def _status_of(engine: Engine, check_in: str) -> tuple[str, Any]:
    with engine.connect() as connection:
        status, completed_at = connection.execute(
            text("SELECT status::text, completed_at FROM check_ins WHERE id = :c"),
            {"c": _uid(check_in)},
        ).one()
    return str(status), completed_at


def test_0022_keys_dates_by_day(scratch_database: tuple[str, Engine]) -> None:
    """Spec 015 rule 13b (issues 233 and 234): a date finding is keyed by its day,
    and a reminder a newer decision version repeated becomes one."""
    url, engine = scratch_database
    upgrade(url, "0021_paycheck_change")
    user = "00000000-0000-4000-8000-0000000000d4"
    _seed_0022(engine, user)

    upgrade(url, "head")

    # Row 1: the same row, keyed by the date.
    [one] = _findings_of(engine, "d1")
    assert (one["id"], one["key"]) == (_uid("w4"), "upcoming_deadline:w4_submit:2026-11-06")
    # Row 2: the newer version's reminder stays, open (not every one was handled).
    [two] = _findings_of(engine, "d2")
    assert (two["id"], two["key"], two["user_action"]) == (
        _uid("v2"),
        "upcoming_deadline:election_check:2026-11-15",
        None,
    )
    assert two["payload"]["calendar_event_id"] == _uid("e:v2")
    # Row 3: both kept and handled; the check-in is still completed.
    assert [(row["key"], row["user_action"]) for row in _findings_of(engine, "d3")] == [
        ("upcoming_deadline:goal_contribution:2026-11-15", "done"),
        ("upcoming_deadline:goal_review:2027-02-15", "done"),
    ]
    assert _status_of(engine, "d3")[0] == "completed"

    # A finding of the new kind, the only open one on row 3's check-in.
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO check_in_findings (user_id, check_in_id, kind, severity, key,"
                " payload) VALUES (:u, :c, 'overdue_deadline', 'alert',"
                " 'overdue_deadline:goal_contribution:2026-11-15', CAST(:payload AS jsonb))"
            ),
            {
                "u": user,
                "c": _uid("d3"),
                "payload": json.dumps(
                    {
                        **_date("e:a", "goal_contribution", "2026-11-15"),
                        "kind": "overdue_deadline",
                        "days_until": -1,
                    }
                ),
            },
        )
        connection.execute(
            text("UPDATE check_ins SET status = 'open', completed_at = NULL WHERE id = :c"),
            {"c": _uid("d3")},
        )

    downgrade(url, "0021_paycheck_change")

    [one_back] = _findings_of(engine, "d1")
    assert one_back["key"] == f"upcoming_deadline:{_uid('e:w4')}"
    assert [row["kind"] for row in _findings_of(engine, "d3")] == ["upcoming_deadline"] * 2
    # Rule 13 again: every finding left on it is handled, the newest at 9:02.
    status, completed_at = _status_of(engine, "d3")
    assert status == "completed"
    assert completed_at.minute == 2
    upgrade(url, "head")


def test_0025_clears_roles_the_kind_does_not_allow(scratch_database: tuple[str, Engine]) -> None:
    """Spec 002 rule 31a (issue 241): a role set before 0025 that its account's
    kind does not allow is cleared; every allowed role stays."""
    url, engine = scratch_database
    upgrade(url, "0024_document_review_draft")
    user = "00000000-0000-4000-8000-0000000000c4"
    rows = [
        ("Checking", "checking", "spending"),
        ("Savings", "savings", "emergency_fund"),
        ("Card", "credit", "spending"),
        ("Brokerage", "investment", "retirement"),
        ("401k", "retirement", "retirement"),
        ("Mortgage", "loan", "spending"),
        ("Car loan", "loan", "retirement"),
        # One emergency fund per user (uq_accounts_one_emergency_fund): the savings.
        ("Card fund", "credit", "retirement"),
        ("Saved spend", "savings", "spending"),
        ("Brokerage spend", "investment", "spending"),
        ("Unset", "loan", None),
    ]
    with engine.begin() as connection:
        connection.execute(text("INSERT INTO auth.users (id) VALUES (:u)"), {"u": user})
        item = connection.execute(
            text("INSERT INTO sync_items (user_id, provider) VALUES (:u, 'csv') RETURNING id"),
            {"u": user},
        ).scalar_one()
        for name, kind, role in rows:
            connection.execute(
                text(
                    "INSERT INTO accounts (user_id, sync_item_id, provider_account_id, kind, name,"
                    " role) VALUES (:u, :i, :name, CAST(:kind AS account_kind), :name,"
                    " CAST(:role AS account_role))"
                ),
                {"u": user, "i": item, "name": name, "kind": kind, "role": role},
            )

    upgrade(url, "0025_account_role_fits_kind")
    with engine.connect() as connection:
        roles: dict[str, str | None] = dict(
            connection.execute(text("SELECT name, role::text FROM accounts")).all()
        )
    assert roles == {
        "Checking": "spending",
        "Savings": "emergency_fund",
        "Card": "spending",
        "Brokerage": "retirement",
        "401k": "retirement",
        "Mortgage": None,
        "Car loan": None,
        "Card fund": None,
        "Saved spend": None,
        "Brokerage spend": None,
        "Unset": None,
    }
