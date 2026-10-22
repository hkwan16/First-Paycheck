"""sync_backlog.py against a fake ``gh`` that keeps GitHub state in memory."""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
import yaml

from scripts import sync_backlog
from scripts.sync_backlog import BacklogError, parse_backlog, retrying, sync

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
            "status": "done",
        },
        {
            "title": "Alembic wiring",
            "body": "0001_roles",
            "labels": ["area:api", "area:data"],
            "milestone": "M0",
            "priority": "Medium",
            "status": "in_progress",
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
STATUS_OPTIONS = {"Todo": "opt-todo", "In Progress": "opt-doing", "Done": "opt-done"}
MILESTONE_FIELDS = ("number", "title", "description", "due_on")
OPTION_NAMES = {v: k for k, v in {**PRIORITY_OPTIONS, **STATUS_OPTIONS}.items()}
MUTATING = {
    ("label", "create"),
    ("issue", "create"),
    ("issue", "close"),
    ("issue", "reopen"),
    ("project", "item-add"),
    ("project", "item-edit"),
    ("project", "field-create"),
}


def _github_due_on(value: str) -> str:
    """GitHub keeps a milestone's date only and answers with Pacific midnight in UTC."""
    return value[:10] + "T07:00:00Z"


@dataclass
class FakeGitHub:
    """Just enough of the gh CLI for sync_backlog, with state that persists across runs."""

    labels: set[str] = field(default_factory=lambda: {"bug"})
    milestones: list[dict[str, Any]] = field(default_factory=list)
    issues: list[dict[str, Any]] = field(default_factory=list)
    items: list[dict[str, Any]] = field(default_factory=list)
    has_priority_field: bool = True
    status_options: dict[str, str] = field(default_factory=lambda: dict(STATUS_OPTIONS))
    calls: list[tuple[str, ...]] = field(default_factory=list)

    def __call__(self, *args: str) -> str:
        self.calls.append(args)
        command = args[:2]
        if command == ("label", "list"):
            return json.dumps([{"name": name} for name in sorted(self.labels)])
        if command == ("label", "create"):
            self.labels.add(args[2])
            return ""
        if args[0] == "api":
            return self._milestones_api(args)
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
                    "state": "OPEN",
                    "labels": _flags(args, "--label"),
                    "milestone": _flag(args, "--milestone"),
                    "assignee": _flag(args, "--assignee"),
                }
            )
            return url + "\n"
        if command in {("issue", "close"), ("issue", "reopen")}:
            issue = next(i for i in self.issues if i["url"] == args[2])
            issue["state"] = "CLOSED" if command[1] == "close" else "OPEN"
            if command[1] == "close":
                issue["reason"] = _flag(args, "--reason")
            return ""
        if command == ("project", "view"):
            return json.dumps({"id": "PROJECT_ID", "number": int(args[2])})
        if command == ("project", "field-list"):
            fields: list[dict[str, Any]] = [
                {"id": "F_TITLE", "name": "Title", "type": "X"},
                {
                    "id": "F_STATUS",
                    "name": "Status",
                    "type": "ProjectV2SingleSelectField",
                    "options": [{"id": i, "name": n} for n, i in self.status_options.items()],
                },
            ]
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
            key = {"F_PRIORITY": "priority", "F_STATUS": "status"}[_flag(args, "--field-id")]
            name = OPTION_NAMES[_flag(args, "--single-select-option-id")]
            for item in self.items:
                if item["id"] == item_id:
                    item[key] = name
            return "{}"
        raise AssertionError(f"unexpected gh call: {args}")

    def _milestones_api(self, args: tuple[str, ...]) -> str:
        path = next(arg for arg in args if arg.startswith("repos/"))
        fields = dict(arg.split("=", 1) for arg in args if "=" in arg and arg != path)
        if "-X" not in args:
            return "".join(
                json.dumps({key: m.get(key) for key in MILESTONE_FIELDS}) + "\n"
                for m in self.milestones
            )
        if "due_on" in fields:
            fields["due_on"] = _github_due_on(fields["due_on"])
        if _flag(args, "-X") == "POST":
            self.milestones.append({"number": len(self.milestones) + 1, **fields})
            return "{}"
        number = int(path.rsplit("/", 1)[1])
        next(m for m in self.milestones if m["number"] == number).update(fields)
        return "{}"

    def mutations(self) -> list[tuple[str, ...]]:
        writes = [call for call in self.calls if call[0] == "api" and "-X" in call]
        return [call for call in self.calls if call[:2] in MUTATING] + writes

    def issue(self, title: str) -> dict[str, Any]:
        return next(i for i in self.issues if i["title"] == title)

    def item(self, title: str) -> dict[str, Any] | None:
        url = self.issue(title)["url"]
        return next((i for i in self.items if i["content"]["url"] == url), None)

    def priority_of(self, title: str) -> str | None:
        item = self.item(title)
        return None if item is None else item.get("priority")

    def status_of(self, title: str) -> str | None:
        item = self.item(title)
        return None if item is None else item.get("status")


def _flag(args: tuple[str, ...], name: str) -> str:
    return args[args.index(name) + 1]


def _flags(args: tuple[str, ...], name: str) -> list[str]:
    return [args[i + 1] for i, arg in enumerate(args) if arg == name]


def _existing(number: int, title: str, state: str = "OPEN") -> dict[str, Any]:
    return {"number": number, "title": title, "url": _url(number), "state": state}


def _url(number: int) -> str:
    return f"https://github.com/o/r/issues/{number}"


def run(gh: FakeGitHub, *, dry_run: bool = False, data: Any = None) -> sync_backlog.Summary:
    backlog = parse_backlog(BACKLOG if data is None else data)
    return sync(backlog, gh, project=7, owner="@me", dry_run=dry_run)


def _copy() -> dict[str, Any]:
    copied: dict[str, Any] = json.loads(json.dumps(BACKLOG))
    return copied


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
        {
            "number": 1,
            "title": "M0: scaffold",
            "description": "Hello world",
            "due_on": "2026-10-22T07:00:00Z",
        },
        {"number": 2, "title": "M1: data model"},
    ]


def test_an_existing_milestone_gets_its_missing_due_date_and_description() -> None:
    gh = FakeGitHub(
        milestones=[{"number": 4, "title": "M0: scaffold", "description": "", "due_on": None}]
    )
    summary = run(gh)
    assert gh.milestones[0] == {
        "number": 4,
        "title": "M0: scaffold",
        "description": "Hello world",
        "due_on": "2026-10-22T07:00:00Z",
    }
    assert summary.milestones_updated == 1
    patch = next(call for call in gh.calls if "PATCH" in call)
    assert any(arg.endswith("/milestones/4") for arg in patch)


def test_a_milestone_that_matches_is_left_alone() -> None:
    gh = FakeGitHub()
    run(gh)
    gh.calls.clear()
    summary = run(gh)
    assert summary.milestones_updated == 0
    assert not any("PATCH" in call for call in gh.calls)


def test_adds_issues_to_the_project_and_sets_priority() -> None:
    gh = FakeGitHub()
    run(gh)
    assert gh.priority_of("Monorepo scaffold") == "High"
    assert gh.priority_of("Alembic wiring") == "Medium"
    assert gh.priority_of("Migration 0002_core") == "Low"


def test_sets_the_status_field_from_the_backlog() -> None:
    gh = FakeGitHub()
    summary = run(gh)
    assert gh.status_of("Monorepo scaffold") == "Done"
    assert gh.status_of("Alembic wiring") == "In Progress"
    assert gh.status_of("Migration 0002_core") == "Todo"
    assert summary.statuses_set == 3


def test_only_a_status_that_differs_is_written() -> None:
    gh = FakeGitHub(
        issues=[_existing(9, "Alembic wiring")],
        items=[{"id": "ITEM_9", "content": {"url": _url(9)}, "priority": "Low", "status": "Todo"}],
    )
    data = _copy()
    data["issues"] = [dict(data["issues"][1], status="todo")]
    summary = run(gh, data=data)
    assert summary.statuses_set == 0
    assert not [call for call in gh.calls if call[:2] == ("project", "item-edit")]


def test_closes_done_issues_as_completed_and_leaves_the_rest_open() -> None:
    gh = FakeGitHub()
    summary = run(gh)
    assert gh.issue("Monorepo scaffold")["state"] == "CLOSED"
    assert gh.issue("Monorepo scaffold")["reason"] == "completed"
    assert gh.issue("Alembic wiring")["state"] == "OPEN"
    assert gh.issue("Migration 0002_core")["state"] == "OPEN"
    assert (summary.closed, summary.reopened) == (1, 0)


def test_reopens_a_closed_issue_that_is_not_done() -> None:
    gh = FakeGitHub(
        issues=[_existing(9, "Alembic wiring", state="CLOSED")],
        items=[{"id": "ITEM_9", "content": {"url": _url(9)}, "status": "Done"}],
    )
    summary = run(gh)
    assert gh.issue("Alembic wiring")["state"] == "OPEN"
    assert gh.status_of("Alembic wiring") == "In Progress"
    assert summary.reopened == 1


def test_a_status_change_in_the_backlog_moves_the_item() -> None:
    gh = FakeGitHub()
    run(gh)
    data = _copy()
    data["issues"][2]["status"] = "done"
    data["issues"][0]["status"] = "todo"
    summary = run(gh, data=data)
    assert gh.status_of("Migration 0002_core") == "Done"
    assert gh.issue("Migration 0002_core")["state"] == "CLOSED"
    assert gh.status_of("Monorepo scaffold") == "Todo"
    assert gh.issue("Monorepo scaffold")["state"] == "OPEN"
    assert (summary.statuses_set, summary.closed, summary.reopened) == (2, 1, 1)


def test_the_state_changes_before_the_status_is_set() -> None:
    # GitHub's built-in workflows move an item when its issue closes or reopens, so the
    # backlog's status is written last and wins.
    gh = FakeGitHub()
    run(gh)
    watched = {("issue", "close"), ("project", "item-edit")}
    order = [call[:2] for call in gh.calls if call[:2] in watched]
    close = order.index(("issue", "close"))
    assert ("project", "item-edit") in order[close + 1 :]


def test_second_run_changes_nothing() -> None:
    gh = FakeGitHub()
    run(gh)
    gh.calls.clear()
    summary = run(gh)
    assert summary == sync_backlog.Summary()
    assert gh.mutations() == []


def test_existing_issues_are_matched_by_title_and_not_duplicated() -> None:
    gh = FakeGitHub(issues=[_existing(9, "Alembic wiring")])
    summary = run(gh)
    assert summary.created == 2
    assert [i["title"] for i in gh.issues].count("Alembic wiring") == 1
    # An existing issue missing from the project is added with its priority and status.
    assert gh.priority_of("Alembic wiring") == "Medium"
    assert gh.status_of("Alembic wiring") == "In Progress"


def test_a_priority_set_on_the_board_is_left_alone() -> None:
    gh = FakeGitHub(
        issues=[_existing(9, "Alembic wiring")],
        items=[{"id": "ITEM_9", "content": {"url": _url(9)}, "priority": "Low", "status": "Todo"}],
    )
    run(gh)
    assert gh.priority_of("Alembic wiring") == "Low"


def test_a_missing_priority_on_an_existing_item_is_filled_in() -> None:
    gh = FakeGitHub(
        issues=[_existing(9, "Alembic wiring")],
        items=[{"id": "ITEM_9", "content": {"url": _url(9)}}],
    )
    run(gh)
    assert gh.priority_of("Alembic wiring") == "Medium"


def test_dry_run_makes_no_changes() -> None:
    gh = FakeGitHub(has_priority_field=False)
    summary = run(gh, dry_run=True)
    assert summary.created == 3
    assert gh.mutations() == []
    assert gh.issues == []


def test_dry_run_reports_status_changes_without_making_them(
    capsys: pytest.CaptureFixture[str],
) -> None:
    gh = FakeGitHub()
    run(gh)
    data = _copy()
    data["issues"][2]["status"] = "done"
    gh.calls.clear()
    summary = run(gh, dry_run=True, data=data)
    assert (summary.statuses_set, summary.closed) == (1, 1)
    assert gh.mutations() == []
    assert gh.status_of("Migration 0002_core") == "Todo"
    out = capsys.readouterr().out
    assert "[dry-run] close" in out
    assert "[dry-run] set Status=Done" in out


def test_creates_the_priority_field_when_missing() -> None:
    gh = FakeGitHub(has_priority_field=False)
    run(gh)
    assert ("project", "field-create") in [call[:2] for call in gh.calls]
    assert gh.priority_of("Monorepo scaffold") == "High"


def test_a_status_field_without_a_backlog_status_is_an_error() -> None:
    gh = FakeGitHub(status_options={"Todo": "opt-todo", "Done": "opt-done"})
    with pytest.raises(BacklogError, match="in_progress"):
        run(gh)
    assert gh.mutations() == []


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
        (lambda b: b["issues"][0].update(status="blocked"), "status"),
        (lambda b: b["issues"][0].update(stauts="done"), "stauts"),
        (lambda b: b["milestones"].update(M0={"title": "M0", "due": "2026-10-22"}), "due"),
    ],
)
def test_invalid_backlogs_are_rejected(mutate: Any, message: str) -> None:
    data = _copy()
    mutate(data)
    with pytest.raises(BacklogError, match=message):
        parse_backlog(data)


def test_status_defaults_to_todo() -> None:
    issues = parse_backlog(BACKLOG).issues
    assert [issue.status for issue in issues] == ["done", "in_progress", "todo"]


def test_yaml_dates_are_accepted() -> None:
    data = yaml.safe_load("milestones:\n  M0: {title: M0, due_on: 2026-10-22}\nissues: []\n")
    assert parse_backlog(data).milestones["M0"].due_on is not None


def test_main_reads_the_yaml_file(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    path = tmp_path / "backlog.yaml"
    path.write_text(yaml.safe_dump(BACKLOG))
    gh = FakeGitHub()
    code = sync_backlog.main(["--backlog", str(path), "--project", "7", "--dry-run"], gh=gh)
    assert code == 0
    assert gh.mutations() == []
    assert "would create 3 issues" in capsys.readouterr().out


def test_main_reports_a_missing_backlog(tmp_path: Path) -> None:
    code = sync_backlog.main(
        ["--backlog", str(tmp_path / "nope.yaml"), "--project", "7"], gh=FakeGitHub()
    )
    assert code == 2


def test_the_committed_backlog_parses() -> None:
    backlog = parse_backlog(yaml.safe_load(sync_backlog.DEFAULT_BACKLOG.read_text()))
    assert backlog.issues
    assert all(milestone.due_on is not None for milestone in backlog.milestones.values())


def test_repo_flag_is_passed_to_gh() -> None:
    gh = FakeGitHub()
    sync(parse_backlog(BACKLOG), gh, project=7, owner="@me", repo="o/r", dry_run=False)
    issue_calls = [call for call in gh.calls if call[0] in {"issue", "label"}]
    assert all("--repo" in call and "o/r" in call for call in issue_calls)
    api_calls = [call for call in gh.calls if call[0] == "api"]
    assert all(any("repos/o/r/milestones" in arg for arg in call) for call in api_calls)


# ---------------------------------------------------------------- rate limits


@dataclass
class Flaky:
    """A gh that fails with the given stderr a number of times, then answers."""

    failures: int
    stderr: str = "HTTP 403: You have exceeded a secondary rate limit."
    calls: int = 0

    def __call__(self, *args: str) -> str:
        self.calls += 1
        if self.calls <= self.failures:
            raise subprocess.CalledProcessError(1, ["gh", *args], output="", stderr=self.stderr)
        return "ok"


@pytest.mark.parametrize(
    "stderr",
    [
        "HTTP 403: You have exceeded a secondary rate limit.",
        "GraphQL: API rate limit exceeded for user ID 1.",
        "GraphQL: was submitted too quickly (createIssue)",
    ],
)
def test_a_rate_limited_call_waits_and_retries(stderr: str) -> None:
    gh = Flaky(failures=2, stderr=stderr)
    slept: list[float] = []
    assert retrying(gh, sleep=slept.append, delays=(5, 10, 20))("issue", "close") == "ok"
    assert gh.calls == 3
    assert slept == [5, 10]


def test_a_call_still_rate_limited_after_every_delay_fails() -> None:
    gh = Flaky(failures=10)
    slept: list[float] = []
    with pytest.raises(subprocess.CalledProcessError):
        retrying(gh, sleep=slept.append, delays=(5, 10))("issue", "close")
    assert gh.calls == 3
    assert slept == [5, 10]


def test_other_failures_are_not_retried() -> None:
    gh = Flaky(failures=1, stderr="GraphQL: Could not resolve to an issue")
    slept: list[float] = []
    with pytest.raises(subprocess.CalledProcessError):
        retrying(gh, sleep=slept.append, delays=(5,))("issue", "close")
    assert (gh.calls, slept) == (1, [])
