"""Seeded generator for ``evals/fixtures/benefits/``: 5 labeled synthetic
benefits summaries for the ``benefits-extraction`` suite (spec 013 rule 16).

The summaries vary what a reader has to cope with:

- layout: ``table`` (a plan grid with one column per plan, employee-only and
  family amounts side by side) or ``prose`` (a paragraph per plan, the
  coinsurance stated as the share the plan pays);
- one to three medical plans (HDHP, PPO, HMO), dental and vision listed too;
- the 401(k) match: tiered, single-tier, dollar for dollar, or none;
- vesting: a cliff, graded, immediate, or not stated;
- one summary prints a synthetic member SSN (area 900-999, never issued) and
  an HSA account number, so redaction is exercised.

Each summary is a text PDF written by hand (Helvetica, no embedded font), so its
bytes depend only on ``SEED`` and a test compares the committed files with a
fresh generation. ``summary-0N.json`` beside each holds the labels: the values a
correct reading proposes, with the match as cumulative tiers the way the
proposal computes them. No real plan document is used.

    uv run python -m evals.gen.make_benefits
"""

from __future__ import annotations

import datetime as dt
import io
import json
import random
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal

SEED = 613
DEFAULT_DIR = Path(__file__).resolve().parents[1] / "fixtures" / "benefits"
LINES_PER_PAGE = 40
PAGE_POINTS = (612, 792)

Layout = Literal["table", "prose"]
Kind = Literal["hdhp", "ppo", "hmo"]

EMPLOYERS = [
    "Acme Corp",
    "Northwind Analytics LLC",
    "Bluebird Robotics Inc",
    "Cedar Health Partners",
    "Lumen Data Co",
    "Harbor Light Studios",
]
PLAN_NAMES: dict[Kind, list[str]] = {
    "hdhp": ["Bronze HSA", "Saver HDHP", "Choice HSA Plan"],
    "ppo": ["Gold PPO", "Premier PPO", "Open Access PPO"],
    "hmo": ["Silver HMO", "Community HMO", "Local Care HMO"],
}


@dataclass(frozen=True)
class Plan:
    name: str
    kind: Kind
    premium_per_period_cents: int
    deductible_cents: int
    oop_max_cents: int
    coinsurance_pct: int
    employer_hsa_cents: int | None

    def labels(self, deadline: dt.date | None) -> dict[str, Any]:
        return {
            "name": self.name,
            "kind": self.kind,
            "premium_per_period_cents": self.premium_per_period_cents,
            "deductible_cents": self.deductible_cents,
            "oop_max_cents": self.oop_max_cents,
            "coinsurance_pct": f"{self.coinsurance_pct}.00",
            "employer_hsa_cents": self.employer_hsa_cents,
            "enrollment_deadline": deadline.isoformat() if deadline else None,
        }


@dataclass(frozen=True)
class Scenario:
    """What a summary must exercise; the amounts come from the seeded generator."""

    layout: Layout
    kinds: tuple[Kind, ...]
    # Each sentence states the match; bands as printed, (band, share).
    match_text: str
    bands: tuple[tuple[int, int], ...]
    vesting_text: str | None
    vesting_years: int | None
    has_deadline: bool
    prints_identifiers: bool


SCENARIOS: tuple[Scenario, ...] = (
    Scenario(
        layout="table",
        kinds=("hdhp", "ppo"),
        match_text=(
            "{employer} matches 100% of the first 3% of pay you contribute,"
            " plus 50% of the next 2%."
        ),
        bands=((3, 100), (2, 50)),
        vesting_text="Matching contributions vest after 3 years of service (cliff vesting).",
        vesting_years=3,
        has_deadline=True,
        prints_identifiers=False,
    ),
    Scenario(
        layout="prose",
        kinds=("ppo",),
        match_text=(
            "{employer} contributes 50 cents for every dollar you save, up to 6% of your pay."
        ),
        bands=((6, 50),),
        vesting_text=(
            "Employer contributions vest 20% for each year of service and are fully"
            " vested after 5 years."
        ),
        vesting_years=5,
        has_deadline=True,
        prints_identifiers=False,
    ),
    Scenario(
        layout="table",
        kinds=("hdhp", "ppo", "hmo"),
        match_text="Employer match: dollar for dollar on contributions up to 4% of eligible pay.",
        bands=((4, 100),),
        vesting_text="You are always 100% vested in employer matching contributions.",
        vesting_years=0,
        has_deadline=True,
        prints_identifiers=True,
    ),
    Scenario(
        layout="prose",
        kinds=("hmo", "hdhp"),
        match_text="The {employer} 401(k) plan does not include an employer matching contribution.",
        bands=(),
        vesting_text=None,
        vesting_years=None,
        has_deadline=False,
        prints_identifiers=False,
    ),
    Scenario(
        layout="table",
        kinds=("hdhp",),
        match_text="401(k) match: 100% on the first 1% of pay, then 50% on the next 5%.",
        bands=((1, 100), (5, 50)),
        vesting_text="Matching contributions are fully vested after 2 years of service.",
        vesting_years=2,
        has_deadline=True,
        prints_identifiers=False,
    ),
)


@dataclass(frozen=True)
class Summary:
    id: str
    scenario: Scenario
    employer: str
    plan_year: int
    plans: tuple[Plan, ...]
    deadline: dt.date | None
    ssn: str | None
    account_number: str | None

    @property
    def filename(self) -> str:
        return f"{self.id}.pdf"

    def match_tiers(self) -> list[dict[str, str]]:
        """The cumulative tiers the proposal computes from the printed bands."""
        tiers = []
        upto = 0
        for band, share in self.scenario.bands:
            upto += band
            tiers.append({"employee_pct_upto": f"{upto}.00", "employer_pct": f"{share}.00"})
        return tiers

    def labels(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "file": self.filename,
            "content_type": "application/pdf",
            "layout": self.scenario.layout,
            "employer": self.employer,
            "plans": [plan.labels(self.deadline) for plan in self.plans],
            "match_tiers": self.match_tiers(),
            "vesting_years": self.scenario.vesting_years,
            "ssn": self.ssn,
            "account_number": self.account_number,
        }


def _cents(rng: random.Random, low: int, high: int, step: int) -> int:
    """A whole multiple of ``step`` cents in [low, high]."""
    return rng.randrange(low // step, high // step + 1) * step


def _plan(rng: random.Random, kind: Kind, used: set[str]) -> Plan:
    name = rng.choice([name for name in PLAN_NAMES[kind] if name not in used])
    used.add(name)
    if kind == "hdhp":
        # At least the 2026 HDHP minimum deductible ($1,700) and under its
        # out-of-pocket ceiling ($8,500), Rev. Proc. 2025-19.
        return Plan(
            name=name,
            kind=kind,
            premium_per_period_cents=_cents(rng, 0, 3_000, 25),
            deductible_cents=_cents(rng, 170_000, 330_000, 5_000),
            oop_max_cents=_cents(rng, 400_000, 750_000, 25_000),
            coinsurance_pct=rng.choice([10, 20, 30]),
            employer_hsa_cents=_cents(rng, 50_000, 150_000, 5_000),
        )
    if kind == "ppo":
        return Plan(
            name=name,
            kind=kind,
            premium_per_period_cents=_cents(rng, 5_000, 9_000, 25),
            deductible_cents=_cents(rng, 50_000, 150_000, 5_000),
            oop_max_cents=_cents(rng, 300_000, 600_000, 25_000),
            coinsurance_pct=rng.choice([10, 20]),
            employer_hsa_cents=None,
        )
    return Plan(
        name=name,
        kind=kind,
        premium_per_period_cents=_cents(rng, 3_000, 6_000, 25),
        deductible_cents=_cents(rng, 0, 50_000, 5_000),
        oop_max_cents=_cents(rng, 250_000, 500_000, 25_000),
        coinsurance_pct=rng.choice([0, 10, 20]),
        employer_hsa_cents=None,
    )


def generate(seed: int = SEED) -> list[Summary]:
    rng = random.Random(seed)  # noqa: S311 (reproducible synthetic data, not security)
    summaries = []
    for index, scenario in enumerate(SCENARIOS, start=1):
        used: set[str] = set()
        plans = tuple(_plan(rng, kind, used) for kind in scenario.kinds)
        plan_year = 2027
        deadline = dt.date(2026, 11, rng.randrange(10, 31)) if scenario.has_deadline else None
        ssn = account = None
        if scenario.prints_identifiers:
            ssn = (
                f"{rng.randrange(900, 1000)}-{rng.randrange(10, 100)}-{rng.randrange(1000, 10000)}"
            )
            account = str(rng.randrange(10**11, 10**12))
        summaries.append(
            Summary(
                id=f"summary-{index:02d}",
                scenario=scenario,
                employer=rng.choice(EMPLOYERS),
                plan_year=plan_year,
                plans=plans,
                deadline=deadline,
                ssn=ssn,
                account_number=account,
            )
        )
    return summaries


def dollars(cents: int) -> str:
    whole, part = divmod(cents, 100)
    return f"${whole:,}" if part == 0 else f"${whole:,}.{part:02d}"


def premium(cents: int) -> str:
    """A per-paycheck amount, always with cents, as payroll prints it."""
    whole, part = divmod(cents, 100)
    return f"${whole:,}.{part:02d}"


def _written(day: dt.date) -> str:
    return f"{day:%B} {day.day}, {day.year}"


def _cell(text: str, width: int = 18) -> str:
    return text.ljust(width)


def _table(summary: Summary) -> list[str]:
    plans = summary.plans
    header = (_cell("", 34) + "".join(_cell(plan.name) for plan in plans)).rstrip()
    rows: list[tuple[str, list[str]]] = [
        ("Plan type", [plan.kind.upper() for plan in plans]),
        ("Premium per paycheck (employee)", [premium(p.premium_per_period_cents) for p in plans]),
        (
            "Deductible (employee / family)",
            [f"{dollars(p.deductible_cents)} / {dollars(p.deductible_cents * 2)}" for p in plans],
        ),
        (
            "Out-of-pocket max (emp / family)",
            [f"{dollars(p.oop_max_cents)} / {dollars(p.oop_max_cents * 2)}" for p in plans],
        ),
        ("Coinsurance (you pay, in network)", [f"{p.coinsurance_pct}%" for p in plans]),
        (
            "Employer HSA contribution",
            [dollars(p.employer_hsa_cents) if p.employer_hsa_cents else "None" for p in plans],
        ),
    ]
    return [
        "Medical plans (26 paychecks a year)",
        header,
        *[
            (_cell(label, 34) + "".join(_cell(value) for value in values)).rstrip()
            for label, values in rows
        ],
    ]


def _prose(summary: Summary) -> list[str]:
    lines = ["Your medical plan choices"]
    for plan in summary.plans:
        pays = 100 - plan.coinsurance_pct
        lines += [
            "",
            f"{plan.name} ({plan.kind.upper()})",
            f"You pay {premium(plan.premium_per_period_cents)} per paycheck for employee-only"
            " coverage.",
            f"The deductible is {dollars(plan.deductible_cents)} for you alone"
            f" ({dollars(plan.deductible_cents * 2)} for a family).",
            f"After the deductible, the plan pays {pays}% of covered in-network costs.",
            f"Your out-of-pocket maximum is {dollars(plan.oop_max_cents)} a year"
            f" ({dollars(plan.oop_max_cents * 2)} for a family).",
        ]
        if plan.employer_hsa_cents:
            lines.append(
                f"{summary.employer} deposits {dollars(plan.employer_hsa_cents)} a year into"
                " your health savings account (HSA)."
            )
    return lines


def render_lines(summary: Summary) -> list[str]:
    scenario = summary.scenario
    lines = [f"{summary.employer} {summary.plan_year} Benefits Summary", ""]
    if summary.ssn is not None and summary.account_number is not None:
        lines += [
            "Prepared for: Taylor Brooks",
            f"Member SSN: {summary.ssn}",
            f"HSA account number: {summary.account_number}",
            "",
        ]
    if summary.deadline is not None:
        lines += [f"Open enrollment closes {_written(summary.deadline)}.", ""]
    lines += _table(summary) if scenario.layout == "table" else _prose(summary)
    lines += [
        "",
        "Dental and vision",
        "Smile Dental PPO: $4.10 per paycheck. VisionCare: $1.25 per paycheck.",
        "",
        "Retirement savings: 401(k)",
        scenario.match_text.format(employer=summary.employer),
    ]
    if scenario.vesting_text is not None:
        lines.append(scenario.vesting_text)
    return lines


def _pdf_string(text: str) -> str:
    escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    return f"({escaped})"


def text_pdf(lines: Sequence[str], *, font_size: int = 10) -> bytes:
    """A text-layer PDF, ``LINES_PER_PAGE`` lines a page, Helvetica, no embedded
    font: the bytes depend only on ``lines``."""
    pages = [
        lines[start : start + LINES_PER_PAGE] for start in range(0, len(lines), LINES_PER_PAGE)
    ]
    objects: list[bytes] = [b"", b""]  # the catalog and pages objects, written last
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    font = len(objects)
    kids = []
    for page in pages:
        ops = [f"BT /F1 {font_size} Tf {font_size + 5} TL 54 738 Td"]
        ops += [f"{_pdf_string(line)} Tj T*" for line in page]
        ops.append("ET")
        stream = "\n".join(ops).encode("latin-1")
        objects.append(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
        content = len(objects)
        objects.append(
            (
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_POINTS[0]} {PAGE_POINTS[1]}]"
                f" /Resources << /Font << /F1 {font} 0 R >> >> /Contents {content} 0 R >>"
            ).encode()
        )
        kids.append(len(objects))
    objects[0] = b"<< /Type /Catalog /Pages 2 0 R >>"
    kid_refs = " ".join(f"{kid} 0 R" for kid in kids)
    objects[1] = f"<< /Type /Pages /Kids [{kid_refs}] /Count {len(kids)} >>".encode()

    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(out.tell())
        out.write(b"%d 0 obj\n" % number + body + b"\nendobj\n")
    xref = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1))
    for offset in offsets:
        out.write(b"%010d 00000 n \n" % offset)
    out.write(
        b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    )
    return out.getvalue()


def render(summary: Summary) -> bytes:
    return text_pdf(render_lines(summary))


def labels_json(summary: Summary) -> str:
    return json.dumps(summary.labels(), indent=2, sort_keys=True) + "\n"


@dataclass(frozen=True)
class Fixture:
    labels: dict[str, Any]
    data: bytes


def load_fixtures(directory: Path = DEFAULT_DIR) -> list[Fixture]:
    fixtures = []
    for path in sorted(directory.glob("*.json")):
        labels = json.loads(path.read_text())
        fixtures.append(Fixture(labels=labels, data=(directory / labels["file"]).read_bytes()))
    return fixtures


def bands_of(tiers: Sequence[dict[str, str]]) -> list[tuple[Decimal, Decimal]]:
    """The printed ``(band, share)`` pairs back from cumulative tier labels."""
    bands = []
    previous = Decimal(0)
    for tier in tiers:
        upto = Decimal(tier["employee_pct_upto"])
        bands.append((upto - previous, Decimal(tier["employer_pct"])))
        previous = upto
    return bands


def write(directory: Path = DEFAULT_DIR, seed: int = SEED) -> list[Path]:
    directory.mkdir(parents=True, exist_ok=True)
    written = []
    for summary in generate(seed):
        document = directory / summary.filename
        document.write_bytes(render(summary))
        labels = directory / f"{summary.id}.json"
        labels.write_text(labels_json(summary))
        written += [document, labels]
    return written


if __name__ == "__main__":
    for path in write():
        sys.stdout.write(f"{path}\n")
