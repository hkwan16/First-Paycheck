"""Sync docs/backlog.yaml to GitHub issues and a GitHub Project, idempotently.

    uv run python scripts/sync_backlog.py --project 1 [--owner @me] [--repo OWNER/REPO] [--dry-run]

The backlog file::

    milestones:
      M0: {title: "M0: scaffold", due_on: 2026-10-22, description: "..."}
      M1: "M1: data model"            # a bare string is the title
    issues:
      - title: Monorepo scaffold
        body: uv workspace, Makefile, pre-commit
        labels: [area:infra]
        milestone: M0                 # a key of `milestones`
        priority: High                # High | Medium | Low
        status: done                  # todo (default) | in_progress | done

Unknown keys are an error, so a misspelled field never goes silently unsynced.

Each run, through the ``gh`` CLI:

1. creates missing labels and milestones, and sets the due date and
   description of an existing milestone when they differ from the backlog;
2. creates every issue whose title does not exist yet (any state), assigned to
   the authenticated user;
3. closes an open issue whose status is ``done`` (as completed) and reopens a
   closed one whose status is not;
4. adds each backlog issue to the project if it is not there, sets the
   Priority field when it is empty (a priority changed on the board is kept),
   and sets the Status field to the backlog's status (the backlog wins).

The issue's state changes before its Status is set, because GitHub's built-in
project workflows move an item when its issue closes or reopens.

A second run changes nothing. ``--dry-run`` prints what would change and makes
no writes. A call that GitHub rate-limits is retried after a growing pause.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import subprocess
import sys
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BACKLOG = REPO_ROOT / "docs" / "backlog.yaml"
PRIORITIES = ("High", "Medium", "Low")
PRIORITY_FIELD = "Priority"
STATUSES = ("todo", "in_progress", "done")
STATUS_FIELD = "Status"
MILESTONE_KEYS = frozenset({"title", "description", "due_on"})
ISSUE_KEYS = frozenset({"title", "body", "labels", "milestone", "priority", "status"})

# gh's stderr when GitHub refuses a call for its primary or secondary rate limit.
RATE_LIMITED = re.compile(r"rate limit|submitted too quickly", re.IGNORECASE)
RETRY_DELAYS: tuple[float, ...] = (60, 120, 240, 480)

Gh = Callable[..., str]


class BacklogError(ValueError):
    """docs/backlog.yaml does not match the schema, or the project lacks a field it needs."""


@dataclass(frozen=True)
class Milestone:
    key: str
    title: str
    description: str | None = None
    due_on: dt.date | None = None


@dataclass(frozen=True)
class Issue:
    title: str
    body: str
    labels: tuple[str, ...]
    milestone: str
    priority: str
    status: str = "todo"


@dataclass(frozen=True)
class Backlog:
    milestones: dict[str, Milestone]
    issues: list[Issue]


@dataclass
class Summary:
    created: int = 0
    added_to_project: int = 0
    priorities_set: int = 0
    statuses_set: int = 0
    closed: int = 0
    reopened: int = 0
    milestones_updated: int = 0


# ---------------------------------------------------------------- parsing


def _str(value: Any, where: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise BacklogError(f"{where} must be a non-empty string")
    return value


def _date(value: Any, where: str) -> dt.date | None:
    if value is None or isinstance(value, dt.date):
        return value
    try:
        return dt.date.fromisoformat(str(value))
    except ValueError as exc:
        raise BacklogError(f"{where} must be a YYYY-MM-DD date") from exc


def _known_keys(value: dict[Any, Any], allowed: frozenset[str], where: str) -> None:
    unknown = sorted(str(key) for key in value if key not in allowed)
    if unknown:
        raise BacklogError(f"{where} has unknown keys {unknown}; allowed: {sorted(allowed)}")


def _milestone(key: str, value: Any) -> Milestone:
    where = f"milestones.{key}"
    if isinstance(value, str):
        return Milestone(key=key, title=_str(value, where))
    if not isinstance(value, dict):
        raise BacklogError(f"{where} must be a title or a mapping")
    _known_keys(value, MILESTONE_KEYS, where)
    description = value.get("description")
    return Milestone(
        key=key,
        title=_str(value.get("title", key), f"{where}.title"),
        description=None if description is None else _str(description, f"{where}.description"),
        due_on=_date(value.get("due_on"), f"{where}.due_on"),
    )


def parse_backlog(data: Any) -> Backlog:
    if not isinstance(data, dict):
        raise BacklogError("the backlog must be a mapping with `milestones` and `issues`")
    raw_milestones = data.get("milestones")
    raw_issues = data.get("issues")
    if not isinstance(raw_milestones, dict):
        raise BacklogError("`milestones` must be a mapping of key to milestone")
    if not isinstance(raw_issues, list):
        raise BacklogError("`issues` must be a list")

    milestones = {str(key): _milestone(str(key), value) for key, value in raw_milestones.items()}
    issues: list[Issue] = []
    titles: set[str] = set()
    for index, raw in enumerate(raw_issues):
        where = f"issues[{index}]"
        if not isinstance(raw, dict):
            raise BacklogError(f"{where} must be a mapping")
        _known_keys(raw, ISSUE_KEYS, where)
        title = _str(raw.get("title"), f"{where}.title")
        if title in titles:
            raise BacklogError(f"{where}: duplicate title {title!r}")
        titles.add(title)
        labels = raw.get("labels", [])
        if not isinstance(labels, list):
            raise BacklogError(f"{where}.labels must be a list")
        milestone = _str(raw.get("milestone"), f"{where}.milestone")
        if milestone not in milestones:
            raise BacklogError(f"{where}.milestone {milestone!r} is not a key of `milestones`")
        priority = _str(raw.get("priority"), f"{where}.priority")
        if priority not in PRIORITIES:
            raise BacklogError(f"{where}.priority must be one of {PRIORITIES}")
        status = _str(raw.get("status", "todo"), f"{where}.status")
        if status not in STATUSES:
            raise BacklogError(f"{where}.status must be one of {STATUSES}")
        issues.append(
            Issue(
                title=title,
                body=_str(raw.get("body"), f"{where}.body"),
                labels=tuple(_str(label, f"{where}.labels") for label in labels),
                milestone=milestone,
                priority=priority,
                status=status,
            )
        )
    return Backlog(milestones=milestones, issues=issues)


# ---------------------------------------------------------------- GitHub


def run_gh(*args: str) -> str:
    return subprocess.run(["gh", *args], capture_output=True, text=True, check=True).stdout


def retrying(
    gh: Gh,
    *,
    sleep: Callable[[float], None] = time.sleep,
    delays: Sequence[float] = RETRY_DELAYS,
) -> Gh:
    """``gh``, retried after each of ``delays`` while GitHub answers with a rate limit.

    A rate-limited request was refused, not applied, so repeating it is safe even
    for a write. Any other failure is raised at once.
    """

    def call(*args: str) -> str:
        for delay in delays:
            try:
                return gh(*args)
            except subprocess.CalledProcessError as exc:
                if not RATE_LIMITED.search(exc.stderr or ""):
                    raise
                print(f"gh {' '.join(args[:2])} was rate limited; retrying in {delay:g} s")
                sleep(delay)
        return gh(*args)

    return call


def _label_color(name: str) -> str:
    return hashlib.sha256(name.encode()).hexdigest()[:6]


def _option_key(name: str) -> str:
    """A project option's name as a backlog value: "In Progress" is ``in_progress``."""
    return "_".join(name.lower().split())


@dataclass(frozen=True)
class _Field:
    id: str
    options: dict[str, str]  # option name -> option id


@dataclass(frozen=True)
class _Project:
    id: str
    priority: _Field | None  # None only in a dry run that would create it
    status: _Field
    status_names: dict[str, str]  # backlog status -> option name


@dataclass(frozen=True)
class _ExistingIssue:
    url: str
    state: str  # OPEN | CLOSED


class _Sync:
    def __init__(
        self, gh: Gh, *, project: int, owner: str, repo: str | None, dry_run: bool
    ) -> None:
        self.gh = gh
        self.project = str(project)
        self.owner = owner
        self.repo_args = ("--repo", repo) if repo else ()
        self.milestones_path = f"repos/{repo or '{owner}/{repo}'}/milestones"
        self.dry_run = dry_run

    def say(self, message: str) -> None:
        print(("[dry-run] " if self.dry_run else "") + message)

    def ensure_labels(self, wanted: set[str]) -> None:
        existing = {
            label["name"]
            for label in json.loads(
                self.gh("label", "list", "--limit", "1000", "--json", "name", *self.repo_args)
            )
        }
        for name in sorted(wanted - existing):
            self.say(f"create label {name}")
            if not self.dry_run:
                self.gh("label", "create", name, "--color", _label_color(name), *self.repo_args)

    def ensure_milestones(self, wanted: list[Milestone]) -> int:
        """Create missing milestones and fix stale ones; return how many were updated."""
        listing = self.gh(
            "api",
            "--paginate",
            f"{self.milestones_path}?state=all&per_page=100",
            "--jq",
            ".[] | {number, title, description, due_on}",
        )
        existing = {
            milestone["title"]: milestone
            for milestone in (json.loads(line) for line in listing.splitlines() if line)
        }
        updated = 0
        for milestone in wanted:
            fields = _milestone_fields(milestone)
            current = existing.get(milestone.title)
            if current is None:
                self.say(f"create milestone {milestone.title}")
                if not self.dry_run:
                    self.gh("api", "-X", "POST", self.milestones_path, *_f(fields))
                continue
            stale = {key: value for key, value in fields.items() if not _same(current, key, value)}
            if not stale:
                continue
            updated += 1
            self.say(f"update milestone {milestone.title}: {', '.join(sorted(stale))}")
            if not self.dry_run:
                path = f"{self.milestones_path}/{current['number']}"
                self.gh("api", "-X", "PATCH", path, *_f(stale))
        return updated

    def existing_issues(self) -> dict[str, _ExistingIssue]:
        issues = json.loads(
            self.gh(
                "issue",
                "list",
                "--state",
                "all",
                "--limit",
                "5000",
                "--json",
                "number,title,url,state",
                *self.repo_args,
            )
        )
        by_title: dict[str, _ExistingIssue] = {}
        for issue in issues:
            by_title.setdefault(issue["title"], _ExistingIssue(issue["url"], issue["state"]))
        return by_title

    def create_issue(self, issue: Issue, milestone: Milestone) -> str | None:
        self.say(f"create issue {issue.title!r} ({issue.priority}, {milestone.title})")
        if self.dry_run:
            return None
        args = ["issue", "create", "--title", issue.title, "--body", issue.body]
        for label in issue.labels:
            args += ["--label", label]
        args += ["--milestone", milestone.title, "--assignee", "@me", *self.repo_args]
        return self.gh(*args).strip().splitlines()[-1]

    def set_state(self, url: str, *, close: bool) -> None:
        self.say(f"{'close' if close else 'reopen'} {url}")
        if self.dry_run:
            return
        if close:
            self.gh("issue", "close", url, "--reason", "completed", *self.repo_args)
        else:
            self.gh("issue", "reopen", url, *self.repo_args)

    def _fields(self) -> list[dict[str, Any]]:
        fields: list[dict[str, Any]] = json.loads(
            self.gh(
                "project",
                "field-list",
                self.project,
                "--owner",
                self.owner,
                "--format",
                "json",
                "--limit",
                "100",
            )
        )["fields"]
        return fields

    def project_setup(self) -> _Project:
        project_id = json.loads(
            self.gh("project", "view", self.project, "--owner", self.owner, "--format", "json")
        )["id"]
        fields = self._fields()
        status = _single_select(fields, STATUS_FIELD)
        if status is None:
            raise BacklogError(f"project {self.project} has no {STATUS_FIELD} field")
        status_names = {_option_key(name): name for name in status.options}
        missing = [s for s in STATUSES if s not in status_names]
        if missing:
            raise BacklogError(
                f"project field {STATUS_FIELD} lacks options for {missing}"
                f" (it has {sorted(status.options)})"
            )
        priority = _single_select(fields, PRIORITY_FIELD)
        if priority is None:
            self.say(f"create project field {PRIORITY_FIELD}")
            if not self.dry_run:
                self.gh(
                    "project",
                    "field-create",
                    self.project,
                    "--owner",
                    self.owner,
                    "--name",
                    PRIORITY_FIELD,
                    "--data-type",
                    "SINGLE_SELECT",
                    "--single-select-options",
                    ",".join(PRIORITIES),
                    "--format",
                    "json",
                )
                priority = _single_select(self._fields(), PRIORITY_FIELD)
        if priority is not None:
            missing = [p for p in PRIORITIES if p not in priority.options]
            if missing:
                raise BacklogError(f"project field {PRIORITY_FIELD} lacks options {missing}")
        return _Project(id=project_id, priority=priority, status=status, status_names=status_names)

    def project_items(self) -> dict[str, dict[str, Any]]:
        items = json.loads(
            self.gh(
                "project",
                "item-list",
                self.project,
                "--owner",
                self.owner,
                "--format",
                "json",
                "--limit",
                "5000",
            )
        )["items"]
        return {
            item["content"]["url"]: item for item in items if item.get("content", {}).get("url")
        }

    def add_to_project(self, url: str) -> str:
        self.say(f"add {url} to project {self.project}")
        added = self.gh(
            "project",
            "item-add",
            self.project,
            "--owner",
            self.owner,
            "--url",
            url,
            "--format",
            "json",
        )
        item_id: str = json.loads(added)["id"]
        return item_id

    def set_option(
        self, project: _Project, item_id: str, name: str, field: _Field | None, option: str
    ) -> None:
        self.say(f"set {name}={option} on {item_id}")
        if self.dry_run or field is None:
            return
        self.gh(
            "project",
            "item-edit",
            "--id",
            item_id,
            "--project-id",
            project.id,
            "--field-id",
            field.id,
            "--single-select-option-id",
            field.options[option],
        )


def _single_select(fields: list[dict[str, Any]], name: str) -> _Field | None:
    field = next((f for f in fields if f["name"] == name), None)
    if field is None:
        return None
    return _Field(id=field["id"], options={o["name"]: o["id"] for o in field.get("options", [])})


def _milestone_fields(milestone: Milestone) -> dict[str, str]:
    fields = {"title": milestone.title}
    if milestone.description:
        fields["description"] = milestone.description
    if milestone.due_on:
        fields["due_on"] = f"{milestone.due_on.isoformat()}T23:59:59Z"
    return fields


def _same(current: dict[str, Any], key: str, wanted: str) -> bool:
    have = current.get(key) or ""
    if key == "due_on":
        # GitHub keeps the date only and answers with a time of its own choosing.
        return bool(have) and str(have)[:10] == wanted[:10]
    return bool(have == wanted)


def _f(fields: dict[str, str]) -> list[str]:
    return [arg for key, value in fields.items() for arg in ("-f", f"{key}={value}")]


def sync(
    backlog: Backlog,
    gh: Gh,
    *,
    project: int,
    owner: str = "@me",
    repo: str | None = None,
    dry_run: bool = False,
) -> Summary:
    session = _Sync(gh, project=project, owner=owner, repo=repo, dry_run=dry_run)
    summary = Summary()
    # Read the board first: a project without the fields the backlog needs fails
    # before anything is written.
    board = session.project_setup()
    session.ensure_labels({label for issue in backlog.issues for label in issue.labels})
    summary.milestones_updated = session.ensure_milestones(list(backlog.milestones.values()))
    existing = session.existing_issues()
    items = session.project_items()

    for issue in backlog.issues:
        found = existing.get(issue.title)
        if found is None:
            url = session.create_issue(issue, backlog.milestones[issue.milestone])
            summary.created += 1
            if url is None:  # dry run
                continue
            found = _ExistingIssue(url=url, state="OPEN")
        url = found.url
        done = issue.status == "done"
        if done != (found.state == "CLOSED"):
            session.set_state(url, close=done)
            if done:
                summary.closed += 1
            else:
                summary.reopened += 1
        item = items.get(url)
        if item is None:
            if dry_run:
                session.say(f"add {url} to project {project}")
                summary.added_to_project += 1
                continue
            # A new item's Status is always written: GitHub's "item added"
            # workflow may give it a default column, but not before this edit.
            item = {"id": session.add_to_project(url)}
            summary.added_to_project += 1
        if not item.get(PRIORITY_FIELD.lower()):
            session.set_option(board, item["id"], PRIORITY_FIELD, board.priority, issue.priority)
            summary.priorities_set += 1
        status = board.status_names[issue.status]
        if item.get(STATUS_FIELD.lower()) != status:
            session.set_option(board, item["id"], STATUS_FIELD, board.status, status)
            summary.statuses_set += 1
    return summary


def main(argv: Sequence[str] | None = None, *, gh: Gh = run_gh) -> int:
    parser = argparse.ArgumentParser(description="Sync docs/backlog.yaml to GitHub.")
    parser.add_argument("--backlog", type=Path, default=DEFAULT_BACKLOG)
    parser.add_argument("--project", type=int, required=True, help="GitHub Project number")
    parser.add_argument("--owner", default="@me", help="project owner login (default: @me)")
    parser.add_argument("--repo", help="OWNER/REPO for issues (default: the current repo)")
    parser.add_argument("--dry-run", action="store_true", help="print changes, write nothing")
    args = parser.parse_args(argv)

    if not args.backlog.is_file():
        print(f"error: {args.backlog} not found", file=sys.stderr)
        return 2
    try:
        backlog = parse_backlog(yaml.safe_load(args.backlog.read_text()))
        summary = sync(
            backlog,
            retrying(gh),
            project=args.project,
            owner=args.owner,
            repo=args.repo,
            dry_run=args.dry_run,
        )
    except BacklogError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except subprocess.CalledProcessError as exc:
        print(f"error: gh {' '.join(exc.cmd[1:3])} failed: {exc.stderr}", file=sys.stderr)
        return 1
    print(
        f"{'would create' if args.dry_run else 'created'} {summary.created} issues, "
        f"added {summary.added_to_project} to the project, set {summary.priorities_set} "
        f"priorities and {summary.statuses_set} statuses, closed {summary.closed} and "
        f"reopened {summary.reopened} issues, updated {summary.milestones_updated} milestones"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
