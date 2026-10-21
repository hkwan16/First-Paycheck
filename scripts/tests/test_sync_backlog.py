"""sync_backlog.py against a fake ``gh`` that keeps GitHub state in memory."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
import yaml

from scripts import sync_backlog
from scripts.sync_backlog import BacklogError, parse_backlog, sync

BACKLOG: dict[str, Any] = {
    "milestones": {
        "M0": {"title": "M0: scaffold", "due_on": "2026-10-22", "description": "Hello world"},
        "M1": "M1: data model",
    },
    "issues": [
        {
            "title": "Monorepo scaffold",
            "body": "uv workspace, Makefile",
            "labels": ["area:infra"],
            "milestone": "M0",
            "priority": "High",
        },
        {
            "title": "Alembic wiring",
            "body": "0001_roles",
            "labels": ["area:api", "area:data"],
            "milestone": "M0",
            "priority": "Medium",
        },
        {
            "title": "Migration 0002_core",
            "body": "Core tables",
            "labels": ["area:data"],
            "milestone": "M1",
            "priority": "Low",
        },
    ],
}

PRIORITY_OPTIONS = {"High": "opt-high", "Medium": "opt-med", "Low": "opt-low"}
MUTATING = {
    ("label", "create"),
    ("issue", "create"),
    ("project", "item-add"),
    ("project", "item-edit"),
    ("project", "field-create"),
}


@dataclass
class FakeGitHub:
    """Just enough of the gh CLI for sync_backlog, with state that persists across runs."""

    labels: set[str] = field(default_factory=lambda: {"bug"})
    milestones: list[dict[str, Any]] = field(default_factory=list)
    issues: list[dict[str, Any]] = field(default_factory=list)
    items: list[dict[str, Any]] = field(default_factory=list)
    has_priority_field: bool = True
    calls: list[tuple[str, ...]] = field(default_factory=list)

    def __call__(self, *args: str) -> str:
        self.calls.append(args)
        command = args[:2]
        if command == ("label", "list"):
            return json.dumps([{"name": name} for name in sorted(self.labels)])
        if command == ("label", "create"):
            self.labels.add(args[2])
            return ""
        if args[0] == "api" and "-X" not in args and "-f" not in args:
            return "".join(f"{m['title']}\n" for m in self.milestones)
        if args[0] == "api":
            created = dict(arg.split("=", 1) for arg in args if "=" in arg)
            self.milestones.append(created)
            return "{}"
        if command == ("issue", "list"):
            return json.dumps(self.issues)
        if command == ("issue", "create"):
            number = len(self.issues) + 1
            url = f"https://github.com/o/r/issues/{number}"
            self.issues.append(
                {
                    "number": number,
                    "title": _flag(args, "--title"),
                    "url": url,
                    "labels": _flags(args, "--label"),
                    "milestone": _flag(args, "--milestone"),
                    "assignee": _flag(args, "--assignee"),
                }
            )
            return url + "\n"
        if command == ("project", "view"):
            return json.dumps({"id": "PROJECT_ID", "number": int(args[2])})
        if command == ("project", "field-list"):
            fields: list[dict[str, Any]] = [{"id": "F_TITLE", "name": "Title", "type": "X"}]
            if self.has_priority_field:
                fields.append(
                    {
                        "id": "F_PRIORITY",
                        "name": "Priority",
                        "type": "ProjectV2SingleSelectField",
                        "options": [{"id": i, "name": n} for n, i in PRIORITY_OPTIONS.items()],
                    }
                )
            return json.dumps({"fields": fields})
        if command == ("project", "field-create"):
            self.has_priority_field = True
            return json.dumps({"id": "F_PRIORITY"})
        if command == ("project", "item-list"):
            return json.dumps({"items": self.items})
        if command == ("project", "item-add"):
            url = _flag(args, "--url")
            for item in self.items:
                if item["content"]["url"] == url:
                    return json.dumps({"id": item["id"]})
            item = {"id": f"ITEM_{len(self.items) + 1}", "content": {"url": url}}
            self.items.append(item)
            return json.dumps({"id": item["id"]})
        if command == ("project", "item-edit"):
            item_id = _flag(args, "--id")
            option = _flag(args, "--single-select-option-id")
            name = {v: k for k, v in PRIORITY_OPTIONS.items()}[option]
            for item in self.items:
                if item["id"] == item_id:
                    item["priority"] = name
            return "{}"
        raise AssertionError(f"unexpected gh call: {args}")

    def mutations(self) -> list[tuple[str, ...]]:
        return [
            call
            for call in self.calls
            if call[:2] in MUTATING or (call[0] == "api" and "-f" in call)
        ]

    def priority_of(self, title: str) -> str | None:
        url = next(i["url"] for i in self.issues if i["title"] == title)
        item = next((i for i in self.items if i["content"]["url"] == url), None)
        return None if item is None else item.get("priority")


def _flag(args: tuple[str, ...], name: str) -> str:
    return args[args.index(name) + 1]


def _flags(args: tuple[str, ...], name: str) -> list[str]:
    return [args[i + 1] for i, arg in enumerate(args) if arg == name]


def run(gh: FakeGitHub, *, dry_run: bool = False) -> sync_backlog.Summary:
    return sync(parse_backlog(BACKLOG), gh, project=7, owner="@me", dry_run=dry_run)


def test_creates_missing_issues_with_labels_milestone_and_assignee() -> None:
    gh = FakeGitHub()
    summary = run(gh)
    assert summary.created == 3
    first = gh.issues[0]
    assert first["title"] == "Monorepo scaffold"
    assert first["labels"] == ["area:infra"]
    assert first["milestone"] == "M0: scaffold"
    assert first["assignee"] == "@me"
    assert {"area:infra", "area:api", "area:data"} <= gh.labels


def test_creates_missing_milestones_with_due_dates() -> None:
    gh = FakeGitHub()
    run(gh)
    assert gh.milestones == [
        {"title": "M0: scaffold", "description": "Hello world", "due_on": "2026-10-22T23:59:59Z"},
        {"title": "M1: data model"},
    ]


def test_adds_issues_to_the_project_and_sets_priority() -> None:
    gh = FakeGitHub()
    run(gh)
    assert gh.priority_of("Monorepo scaffold") == "High"
    assert gh.priority_of("Alembic wiring") == "Medium"
    assert gh.priority_of("Migration 0002_core") == "Low"


def test_second_run_changes_nothing() -> None:
    gh = FakeGitHub()
    run(gh)
    gh.calls.clear()
    summary = run(gh)
    assert summary.created == 0
    assert gh.mutations() == []


def test_existing_issues_are_matched_by_title_and_not_duplicated() -> None:
    gh = FakeGitHub(
        issues=[{"number": 9, "title": "Alembic wiring", "url": "https://github.com/o/r/issues/9"}]
    )
    summary = run(gh)
    assert summary.created == 2
    assert [i["title"] for i in gh.issues].count("Alembic wiring") == 1
    # An existing issue missing from the project is added with its priority.
    assert gh.priority_of("Alembic wiring") == "Medium"


def test_a_priority_set_on_the_board_is_left_alone() -> None:
    url = "https://github.com/o/r/issues/9"
    gh = FakeGitHub(
        issues=[{"number": 9, "title": "Alembic wiring", "url": url}],
        items=[{"id": "ITEM_9", "content": {"url": url}, "priority": "Low"}],
    )
    run(gh)
    assert gh.priority_of("Alembic wiring") == "Low"


def test_a_missing_priority_on_an_existing_item_is_filled_in() -> None:
    url = "https://github.com/o/r/issues/9"
    gh = FakeGitHub(
        issues=[{"number": 9, "title": "Alembic wiring", "url": url}],
        items=[{"id": "ITEM_9", "content": {"url": url}}],
    )
    run(gh)
    assert gh.priority_of("Alembic wiring") == "Medium"


def test_dry_run_makes_no_changes() -> None:
    gh = FakeGitHub(has_priority_field=False)
    summary = run(gh, dry_run=True)
    assert summary.created == 3
    assert gh.mutations() == []
    assert gh.issues == []


def test_creates_the_priority_field_when_missing() -> None:
    gh = FakeGitHub(has_priority_field=False)
    run(gh)
    assert ("project", "field-create") in [call[:2] for call in gh.calls]
    assert gh.priority_of("Monorepo scaffold") == "High"


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda b: b.pop("issues"), "issues"),
        (lambda b: b["issues"][0].update(priority="Urgent"), "priority"),
        (lambda b: b["issues"][0].update(milestone="M9"), "M9"),
        (lambda b: b["issues"][0].pop("body"), "body"),
        (lambda b: b["issues"][1].update(title="Monorepo scaffold"), "duplicate"),
        (lambda b: b["issues"][0].update(labels="area:infra"), "labels"),
        (lambda b: b["milestones"].update(M0={"due_on": "next week"}), "due_on"),
    ],
)
def test_invalid_backlogs_are_rejected(mutate: Any, message: str) -> None:
    data = json.loads(json.dumps(BACKLOG))
    mutate(data)
    with pytest.raises(BacklogError, match=message):
        parse_backlog(data)


def test_yaml_dates_are_accepted() -> None:
    data = yaml.safe_load("milestones:\n  M0: {title: M0, due_on: 2026-10-22}\nissues: []\n")
    assert parse_backlog(data).milestones["M0"].due_on is not None


def test_main_reads_the_yaml_file(tmp_path: Path) -> None:
    path = tmp_path / "backlog.yaml"
    path.write_text(yaml.safe_dump(BACKLOG))
    gh = FakeGitHub()
    code = sync_backlog.main(["--backlog", str(path), "--project", "7", "--dry-run"], gh=gh)
    assert code == 0
    assert gh.mutations() == []


def test_main_reports_a_missing_backlog(tmp_path: Path) -> None:
    code = sync_backlog.main(
        ["--backlog", str(tmp_path / "nope.yaml"), "--project", "7"], gh=FakeGitHub()
    )
    assert code == 2


def test_repo_flag_is_passed_to_gh() -> None:
    gh = FakeGitHub()
    sync(parse_backlog(BACKLOG), gh, project=7, owner="@me", repo="o/r", dry_run=False)
    issue_calls = [call for call in gh.calls if call[0] in {"issue", "label"}]
    assert all("--repo" in call and "o/r" in call for call in issue_calls)
    api_calls = [call for call in gh.calls if call[0] == "api"]
    assert all(any("repos/o/r/milestones" in arg for arg in call) for call in api_calls)
