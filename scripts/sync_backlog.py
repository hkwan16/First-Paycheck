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

Each run, through the ``gh`` CLI:

1. creates missing labels and milestones;
2. creates every issue whose title does not exist yet (any state), assigned to
   the authenticated user;
3. adds each backlog issue to the project if it is not there and sets the
   Priority field when it is empty (a priority changed on the board is kept).

A second run changes nothing. ``--dry-run`` prints what would change and makes
no writes.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import subprocess
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BACKLOG = REPO_ROOT / "docs" / "backlog.yaml"
PRIORITIES = ("High", "Medium", "Low")
PRIORITY_FIELD = "Priority"

Gh = Callable[..., str]


class BacklogError(ValueError):
    """docs/backlog.yaml does not match the schema."""


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


@dataclass(frozen=True)
class Backlog:
    milestones: dict[str, Milestone]
    issues: list[Issue]


@dataclass
class Summary:
    created: int = 0
    added_to_project: int = 0
    priorities_set: int = 0


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


def _milestone(key: str, value: Any) -> Milestone:
    where = f"milestones.{key}"
    if isinstance(value, str):
        return Milestone(key=key, title=_str(value, where))
    if not isinstance(value, dict):
        raise BacklogError(f"{where} must be a title or a mapping")
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
        issues.append(
            Issue(
                title=title,
                body=_str(raw.get("body"), f"{where}.body"),
                labels=tuple(_str(label, f"{where}.labels") for label in labels),
                milestone=milestone,
                priority=priority,
            )
        )
    return Backlog(milestones=milestones, issues=issues)


# ---------------------------------------------------------------- GitHub


def run_gh(*args: str) -> str:
    return subprocess.run(["gh", *args], capture_output=True, text=True, check=True).stdout


def _label_color(name: str) -> str:
    return hashlib.sha256(name.encode()).hexdigest()[:6]


@dataclass(frozen=True)
class _Project:
    id: str
    priority_field: str | None
    options: dict[str, str]


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

    def ensure_milestones(self, wanted: list[Milestone]) -> None:
        listing = self.gh(
            "api",
            "--paginate",
            f"{self.milestones_path}?state=all&per_page=100",
            "--jq",
            ".[].title",
        )
        existing = {line for line in listing.splitlines() if line}
        for milestone in wanted:
            if milestone.title in existing:
                continue
            self.say(f"create milestone {milestone.title}")
            if self.dry_run:
                continue
            fields = ["-f", f"title={milestone.title}"]
            if milestone.description:
                fields += ["-f", f"description={milestone.description}"]
            if milestone.due_on:
                fields += ["-f", f"due_on={milestone.due_on.isoformat()}T23:59:59Z"]
            self.gh("api", "-X", "POST", self.milestones_path, *fields)

    def existing_issues(self) -> dict[str, str]:
        issues = json.loads(
            self.gh(
                "issue",
                "list",
                "--state",
                "all",
                "--limit",
                "5000",
                "--json",
                "number,title,url",
                *self.repo_args,
            )
        )
        by_title: dict[str, str] = {}
        for issue in issues:
            by_title.setdefault(issue["title"], issue["url"])
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

    def project_setup(self) -> _Project:
        project_id = json.loads(
            self.gh("project", "view", self.project, "--owner", self.owner, "--format", "json")
        )["id"]
        fields = json.loads(
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
        field = next((f for f in fields if f["name"] == PRIORITY_FIELD), None)
        if field is None:
            self.say(f"create project field {PRIORITY_FIELD}")
            if self.dry_run:
                return _Project(id=project_id, priority_field=None, options={})
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
            return self.project_setup()
        options = {option["name"]: option["id"] for option in field.get("options", [])}
        missing = [p for p in PRIORITIES if p not in options]
        if missing:
            raise BacklogError(f"project field {PRIORITY_FIELD} lacks options {missing}")
        return _Project(id=project_id, priority_field=field["id"], options=options)

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

    def set_priority(self, project: _Project, item_id: str, priority: str) -> None:
        self.say(f"set {PRIORITY_FIELD}={priority} on {item_id}")
        if self.dry_run or project.priority_field is None:
            return
        self.gh(
            "project",
            "item-edit",
            "--id",
            item_id,
            "--project-id",
            project.id,
            "--field-id",
            project.priority_field,
            "--single-select-option-id",
            project.options[priority],
        )


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
    session.ensure_labels({label for issue in backlog.issues for label in issue.labels})
    session.ensure_milestones(list(backlog.milestones.values()))
    existing = session.existing_issues()
    board = session.project_setup()
    items = session.project_items()

    for issue in backlog.issues:
        url = existing.get(issue.title)
        if url is None:
            url = session.create_issue(issue, backlog.milestones[issue.milestone])
            summary.created += 1
            if url is None:  # dry run
                continue
        item = items.get(url)
        if item is None:
            if dry_run:
                session.say(f"add {url} to project {project}")
                summary.added_to_project += 1
                continue
            item = {"id": session.add_to_project(url)}
            summary.added_to_project += 1
        if not item.get(PRIORITY_FIELD.lower()):
            session.set_priority(board, item["id"], issue.priority)
            summary.priorities_set += 1
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
            gh,
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
        f"added {summary.added_to_project} to the project, set {summary.priorities_set} priorities"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
