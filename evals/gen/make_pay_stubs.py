# WeasyPrint and pypdfium2 ship no type information; the exemption is scoped to this file.
# mypy: disable-error-code="import-untyped"
"""Seeded generator for ``evals/fixtures/pay_stubs/``: 30 labeled synthetic pay
stubs for the extraction suites (spec 005 rules 26-27).

Three layouts in the style of common payroll providers: ``ledger`` (a dense
earnings statement with this-period and year-to-date columns, slash dates),
``summary`` (a modern pay summary with written-out dates and no year-to-date
column) and ``advice`` (a payroll advice with earnings and deductions side by
side, ISO dates and the deposit split from the net pay line). Each stub is
HTML rendered to PDF with WeasyPrint; image stubs are that PDF rasterized with
pypdfium2 at 200 dpi, some with scan-style speckle, blur and a slight
rotation, some wrapped back into a PDF with no text layer.
Several print a synthetic SSN (area 900-999, never issued) and an account
number, masked or in full, so redaction is exercised.

Next to each document, ``<id>.json`` holds its labels: the values a correct
reading gives, with ``null`` for an amount the stub does not print.

    DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib uv run python -m evals.gen.make_pay_stubs

(the library path is for WeasyPrint on macOS with Homebrew). The labels depend
only on ``SEED``, and a test checks the committed JSON matches; the rendered
bytes depend on the fonts installed, so they are committed, not compared.
"""

from __future__ import annotations

import datetime as dt
import html
import io
import json
import random
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

SEED = 146
DEFAULT_DIR = Path(__file__).resolve().parents[1] / "fixtures" / "pay_stubs"
RASTER_DPI = 200

Layout = Literal["ledger", "summary", "advice"]
Output = Literal["text_pdf", "png", "noisy_png", "noisy_jpeg", "scanned_pdf"]
Frequency = Literal["weekly", "biweekly", "semimonthly", "monthly"]

PERIODS_PER_YEAR: dict[Frequency, int] = {
    "weekly": 52,
    "biweekly": 26,
    "semimonthly": 24,
    "monthly": 12,
}
FREQUENCY_LABELS: dict[Frequency, str] = {
    "weekly": "Weekly",
    "biweekly": "Bi-weekly",
    "semimonthly": "Semi-monthly",
    "monthly": "Monthly",
}
EMPLOYERS = [
    ("Acme Corp", "100 Market St, San Francisco, CA 94105", "CA"),
    ("Northwind Analytics LLC", "2200 Pine Ave, Seattle, WA 98101", "WA"),
    ("Bluebird Robotics Inc", "77 Congress Ave, Austin, TX 78701", "TX"),
    ("Cedar Health Partners", "15 Elm St, Boston, MA 02108", "MA"),
    ("Lumen Data Co", "480 Lake Shore Dr, Chicago, IL 60611", "IL"),
    ("Harbor Light Studios", "9 Mission Blvd, Oakland, CA 94607", "CA"),
]
EMPLOYEES = [
    "Jordan Rivera",
    "Priya Natarajan",
    "Sam Okafor",
    "Mei Lin Chen",
    "Alex Moreno",
    "Taylor Brooks",
    "Noor Haddad",
    "Chris Delgado",
    "Emma Kowalski",
    "Diego Santos",
]
# Flat-rate state income tax, or None for a state without one.
STATE_RATES: dict[str, float | None] = {
    "CA": 0.045,
    "WA": None,
    "TX": None,
    "MA": 0.05,
    "IL": 0.0495,
}
SALARIES = [52_000, 61_500, 68_000, 74_250, 82_000, 95_000, 110_000, 128_500]


@dataclass(frozen=True)
class Plan:
    """What varies by position, so every format and identifier case is covered."""

    layout: Layout
    output: Output
    ssn: Literal["full", "masked", "none"]
    account: Literal["full", "masked", "none"]


PLANS: tuple[Plan, ...] = (
    Plan("ledger", "text_pdf", "full", "masked"),
    Plan("summary", "text_pdf", "none", "full"),
    Plan("ledger", "png", "full", "masked"),
    Plan("summary", "png", "full", "full"),
    Plan("ledger", "noisy_jpeg", "full", "none"),
    Plan("summary", "noisy_jpeg", "none", "masked"),
    Plan("ledger", "scanned_pdf", "full", "masked"),
    Plan("summary", "text_pdf", "masked", "masked"),
    Plan("ledger", "noisy_png", "full", "full"),
    Plan("summary", "text_pdf", "full", "full"),
    # M10: twenty more, with the advice layout, every output and identifier case.
    Plan("advice", "text_pdf", "full", "masked"),
    Plan("advice", "png", "none", "full"),
    Plan("advice", "noisy_png", "full", "full"),
    Plan("advice", "scanned_pdf", "masked", "masked"),
    Plan("ledger", "text_pdf", "none", "none"),
    Plan("summary", "noisy_png", "full", "masked"),
    Plan("advice", "noisy_jpeg", "full", "masked"),
    Plan("ledger", "png", "masked", "full"),
    Plan("summary", "scanned_pdf", "full", "none"),
    Plan("advice", "text_pdf", "full", "full"),
    Plan("ledger", "noisy_png", "none", "masked"),
    Plan("summary", "png", "full", "masked"),
    Plan("advice", "png", "full", "none"),
    Plan("ledger", "scanned_pdf", "none", "full"),
    Plan("summary", "noisy_jpeg", "full", "full"),
    Plan("ledger", "text_pdf", "masked", "full"),
    Plan("advice", "noisy_jpeg", "none", "none"),
    Plan("summary", "text_pdf", "full", "masked"),
    Plan("ledger", "noisy_jpeg", "full", "masked"),
    Plan("advice", "scanned_pdf", "full", "full"),
)


@dataclass(frozen=True)
class Line:
    label: str
    cents: int
    # The pay_stubs column the line is counted in; None means other deductions.
    field: str | None


@dataclass(frozen=True)
class Stub:
    id: str
    layout: Layout
    output: Output
    employer: str
    employer_address: str
    employee: str
    frequency: Frequency
    pay_date: dt.date
    period_start: dt.date
    period_end: dt.date
    # Periods paid so far this year, including this one (for year-to-date columns).
    period_number: int
    earnings: tuple[Line, ...]
    taxes: tuple[Line, ...]
    deductions: tuple[Line, ...]
    ssn: str | None
    ssn_masked: bool
    account: str | None
    account_masked: bool
    noise_seed: int
    rotation: float = 0.0

    @property
    def gross_cents(self) -> int:
        return sum(line.cents for line in self.earnings)

    @property
    def net_cents(self) -> int:
        withheld = sum(line.cents for line in (*self.taxes, *self.deductions))
        return self.gross_cents - withheld

    @property
    def ssn_last4(self) -> str:
        return self.ssn[-4:] if self.ssn else ""

    @property
    def content_type(self) -> str:
        if self.output in ("text_pdf", "scanned_pdf"):
            return "application/pdf"
        return "image/jpeg" if self.output == "noisy_jpeg" else "image/png"

    @property
    def filename(self) -> str:
        extension = {"application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg"}
        return f"{self.id}.{extension[self.content_type]}"

    def column(self, name: str) -> int | None:
        """The amount for one ``pay_stubs`` column, or None when not printed."""
        lines = [line for line in (*self.taxes, *self.deductions) if line.field == name]
        return sum(line.cents for line in lines) if lines else None

    def labels(self) -> dict[str, Any]:
        other = sum(line.cents for line in self.deductions if line.field is None)
        other += sum(line.cents for line in self.taxes if line.field is None)
        return {
            "id": self.id,
            "file": self.filename,
            "content_type": self.content_type,
            "layout": self.layout,
            "output": self.output,
            "fields": {
                "employer_name": self.employer,
                "pay_frequency": self.frequency,
                "pay_date": self.pay_date.isoformat(),
                "period_start": self.period_start.isoformat(),
                "period_end": self.period_end.isoformat(),
                "gross_cents": self.gross_cents,
                "federal_withholding_cents": self.column("federal_withholding_cents"),
                "social_security_cents": self.column("social_security_cents"),
                "medicare_cents": self.column("medicare_cents"),
                "state_tax_cents": self.column("state_tax_cents"),
                "retirement_contribution_cents": self.column("retirement_contribution_cents"),
                "medical_premium_cents": self.column("medical_premium_cents"),
                "other_deductions_cents": other,
                "net_cents": self.net_cents,
            },
            # Printed in full, so the redaction must remove it; null otherwise.
            "ssn": self.ssn if self.ssn and not self.ssn_masked else None,
            "account_number": self.account if self.account and not self.account_masked else None,
        }


# ---------------------------------------------------------------- generation


def _period(rng: random.Random, frequency: Frequency) -> tuple[dt.date, dt.date, dt.date, int]:
    """(pay_date, period_start, period_end, period number in the year)."""
    if frequency == "semimonthly":
        month = rng.randint(2, 11)
        first_half = rng.random() < 0.5
        start = dt.date(2026, month, 1 if first_half else 16)
        next_month = dt.date(2026, month + 1, 1)
        end = dt.date(2026, month, 15) if first_half else next_month - dt.timedelta(days=1)
        return end, start, end, (month - 1) * 2 + (1 if first_half else 2)
    if frequency == "monthly":
        month = rng.randint(2, 11)
        start = dt.date(2026, month, 1)
        end = dt.date(2026, month + 1, 1) - dt.timedelta(days=1)
        return end, start, end, month
    length = 7 if frequency == "weekly" else 14
    number = rng.randint(4, 40 if frequency == "weekly" else 20)
    first_friday = dt.date(2026, 1, 2)
    pay_date = first_friday + dt.timedelta(days=length * (number - 1))
    end = pay_date - dt.timedelta(days=rng.choice([0, 2, 5]))
    return pay_date, end - dt.timedelta(days=length - 1), end, number


def _cents(value: float) -> int:
    return round(value)


def _stub(index: int, plan: Plan, rng: random.Random) -> Stub:
    employer, address, state = EMPLOYERS[index % len(EMPLOYERS)]
    frequency: Frequency = rng.choice(list(PERIODS_PER_YEAR))
    pay_date, start, end, number = _period(rng, frequency)
    salary = rng.choice(SALARIES)
    regular = _cents(salary * 100 / PERIODS_PER_YEAR[frequency])
    earnings = [Line("Regular Pay", regular, None)]
    if rng.random() < 0.3:
        earnings.append(Line("Bonus", rng.choice([25_000, 50_000, 75_000]), None))
    gross = sum(line.cents for line in earnings)

    taxes = [
        Line(
            "Federal Income Tax",
            _cents(gross * rng.uniform(0.07, 0.14)),
            "federal_withholding_cents",
        ),
        Line("Social Security", _cents(gross * 0.062), "social_security_cents"),
        Line("Medicare", _cents(gross * 0.0145), "medicare_cents"),
    ]
    rate = STATE_RATES[state]
    if rate is not None:
        taxes.append(Line(f"{state} State Income Tax", _cents(gross * rate), "state_tax_cents"))
    if state == "CA":
        taxes.append(Line("CA SDI", _cents(gross * 0.011), None))

    deductions: list[Line] = []
    if rng.random() < 0.6:
        percent = rng.choice([0.03, 0.04, 0.05, 0.06, 0.08])
        deductions.append(Line("401(k)", _cents(gross * percent), "retirement_contribution_cents"))
    if rng.random() < 0.75:
        premium = rng.choice([2_500, 4_150, 6_250, 8_800])
        deductions.append(Line("Medical Pre-Tax", premium, "medical_premium_cents"))
    if rng.random() < 0.6:
        deductions.append(Line("Dental", rng.choice([620, 940, 1_180]), None))
    if rng.random() < 0.4:
        deductions.append(Line("Vision", rng.choice([280, 410]), None))
    if rng.random() < 0.3:
        deductions.append(Line("Commuter Transit", rng.choice([5_000, 7_500]), None))

    ssn = f"9{rng.randint(0, 99):02d}-{rng.randint(10, 99)}-{rng.randint(1000, 9999)}"
    account = str(rng.randint(10**9, 10**12 - 1))
    noise_seed = rng.randint(0, 2**31 - 1)
    rotation = round(rng.uniform(-1.2, 1.2), 2) if plan.output.startswith("noisy") else 0.0
    if plan.output == "scanned_pdf":
        rotation = round(rng.uniform(-0.8, 0.8), 2)
    return Stub(
        id=f"stub-{index + 1:02d}",
        layout=plan.layout,
        output=plan.output,
        employer=employer,
        employer_address=address,
        employee=EMPLOYEES[index % len(EMPLOYEES)],
        frequency=frequency,
        pay_date=pay_date,
        period_start=start,
        period_end=end,
        period_number=number,
        earnings=tuple(earnings),
        taxes=tuple(taxes),
        deductions=tuple(deductions),
        ssn=None if plan.ssn == "none" else ssn,
        ssn_masked=plan.ssn == "masked",
        account=None if plan.account == "none" else account,
        account_masked=plan.account == "masked",
        noise_seed=noise_seed,
        rotation=rotation,
    )


def generate(seed: int = SEED) -> list[Stub]:
    rng = random.Random(seed)  # noqa: S311 (reproducible synthetic data, not security)
    return [_stub(index, plan, rng) for index, plan in enumerate(PLANS)]


# ---------------------------------------------------------------- HTML


def dollars(cents: int) -> str:
    return f"{cents // 100:,}.{cents % 100:02d}"


def _slash(day: dt.date) -> str:
    return day.strftime("%m/%d/%Y")


def _written(day: dt.date) -> str:
    return f"{day.strftime('%b')} {day.day}, {day.year}"


def _identity_lines(stub: Stub) -> list[str]:
    lines = []
    if stub.ssn is not None:
        printed = f"XXX-XX-{stub.ssn_last4}" if stub.ssn_masked else stub.ssn
        lines.append(f"SSN {printed}")
    if stub.account is not None:
        printed = f"******{stub.account[-4:]}" if stub.account_masked else stub.account
        lines.append(f"Direct Deposit Acct {printed}")
    return lines


def _rows(lines: Sequence[Line], ytd: int | None) -> str:
    cells = []
    for line in lines:
        label = f"<td>{html.escape(line.label)}</td>"
        amount = f"<td class='num'>{dollars(line.cents)}</td>"
        year = f"<td class='num'>{dollars(line.cents * ytd)}</td>" if ytd else ""
        cells.append(f"<tr>{label}{amount}{year}</tr>")
    return "".join(cells)


HEADER = (
    "<tr><th>Description</th><th class='num'>This Period</th><th class='num'>Year to Date</th></tr>"
)


STYLE = """
@page { size: letter; margin: 0.6in; }
body { font-family: "Helvetica Neue", Helvetica, Arial, "DejaVu Sans", sans-serif;
       font-size: 11pt; color: #000; }
h1 { font-size: 16pt; margin: 0 0 4pt 0; }
h2 { font-size: 12pt; margin: 14pt 0 4pt 0; }
table { border-collapse: collapse; width: 100%; }
td, th { padding: 3pt 6pt; text-align: left; }
th { border-bottom: 1.5pt solid #000; }
.num { text-align: right; }
.meta td { padding: 1pt 6pt 1pt 0; }
.total td { border-top: 1.5pt solid #000; font-weight: bold; }
"""


def _ledger(stub: Stub) -> str:
    ytd = stub.period_number
    identity = "".join(f"<div>{html.escape(line)}</div>" for line in _identity_lines(stub))
    withheld = (*stub.taxes, *stub.deductions)
    return f"""
<h1>{html.escape(stub.employer)}</h1>
<div>{html.escape(stub.employer_address)}</div>
<h2>EARNINGS STATEMENT</h2>
<table class="meta">
<tr><td>Employee</td><td>{html.escape(stub.employee)}</td></tr>
<tr><td>Pay Date</td><td>{_slash(stub.pay_date)}</td></tr>
<tr><td>Period</td><td>{_slash(stub.period_start)} - {_slash(stub.period_end)}</td></tr>
<tr><td>Pay Frequency</td><td>{FREQUENCY_LABELS[stub.frequency]}</td></tr>
</table>
{identity}
<h2>Earnings</h2>
<table>{HEADER}
{_rows(stub.earnings, ytd)}
<tr class="total"><td>Gross Pay</td><td class="num">{dollars(stub.gross_cents)}</td>
<td class="num">{dollars(stub.gross_cents * ytd)}</td></tr></table>
<h2>Taxes and Deductions</h2>
<table>{HEADER}
{_rows(withheld, ytd)}</table>
<table><tr class="total"><td>Net Pay</td><td class="num">{dollars(stub.net_cents)}</td>
<td class="num">{dollars(stub.net_cents * ytd)}</td></tr></table>
"""


def _summary(stub: Stub) -> str:
    identity = "".join(f"<div>{html.escape(line)}</div>" for line in _identity_lines(stub))
    return f"""
<h1>Pay summary</h1>
<div>{html.escape(stub.employer)} &middot; {html.escape(stub.employer_address)}</div>
<table class="meta">
<tr><td>Paid to</td><td>{html.escape(stub.employee)}</td></tr>
<tr><td>Pay day</td><td>{_written(stub.pay_date)}</td></tr>
<tr><td>Pay period</td><td>{_written(stub.period_start)} to {_written(stub.period_end)}</td></tr>
<tr><td>Pay schedule</td><td>{FREQUENCY_LABELS[stub.frequency]}</td></tr>
</table>
{identity}
<h2>Gross earnings</h2>
<table>{_rows(stub.earnings, None)}
<tr class="total"><td>Gross pay</td><td class="num">${dollars(stub.gross_cents)}</td></tr></table>
<h2>Employee taxes</h2>
<table>{_rows(stub.taxes, None)}</table>
<h2>Deductions</h2>
<table>{_rows(stub.deductions, None) or "<tr><td>None</td><td></td></tr>"}</table>
<h2>Take-home</h2>
<table><tr class="total"><td>Net pay</td>
<td class="num">${dollars(stub.net_cents)}</td></tr></table>
"""


def _iso(day: dt.date) -> str:
    return day.isoformat()


def _side(lines: Sequence[Line]) -> list[str]:
    return [
        f"<td>{html.escape(line.label)}</td><td class='num'>{dollars(line.cents)}</td>"
        for line in lines
    ]


ADVICE_HEADER = (
    '<tr><th>Earnings</th><th class="num">Amount</th>'
    '<th>Withholdings</th><th class="num">Amount</th></tr>'
)


def _advice(stub: Stub) -> str:
    """Earnings on the left, taxes and deductions on the right, row by row."""
    left = _side(stub.earnings)
    right = _side((*stub.taxes, *stub.deductions))
    blank = "<td></td><td></td>"
    rows = "".join(
        f"<tr>{left[i] if i < len(left) else blank}{right[i] if i < len(right) else blank}</tr>"
        for i in range(max(len(left), len(right)))
    )
    withheld = stub.gross_cents - stub.net_cents
    identity = "".join(f"<div>{html.escape(line)}</div>" for line in _identity_lines(stub))
    return f"""
<h1>PAYROLL ADVICE</h1>
<table class="meta">
<tr><td>Company</td><td>{html.escape(stub.employer)}</td></tr>
<tr><td>Address</td><td>{html.escape(stub.employer_address)}</td></tr>
<tr><td>Employee name</td><td>{html.escape(stub.employee)}</td></tr>
<tr><td>Check date</td><td>{_iso(stub.pay_date)}</td></tr>
<tr><td>Period beginning</td><td>{_iso(stub.period_start)}</td></tr>
<tr><td>Period ending</td><td>{_iso(stub.period_end)}</td></tr>
<tr><td>Pay frequency</td><td>{FREQUENCY_LABELS[stub.frequency]}</td></tr>
</table>
{identity}
<h2>Current period</h2>
<table>
{ADVICE_HEADER}
{rows}
<tr class="total"><td>Total gross</td><td class="num">{dollars(stub.gross_cents)}</td>
<td>Total withheld</td><td class="num">{dollars(withheld)}</td></tr>
</table>
<h2>Net pay distribution</h2>
<table><tr class="total"><td>Net pay</td><td class="num">{dollars(stub.net_cents)}</td></tr>
<tr><td>Direct deposit</td><td class="num">{dollars(stub.net_cents)}</td></tr></table>
"""


LAYOUTS = {"ledger": _ledger, "summary": _summary, "advice": _advice}


def render_html(stub: Stub) -> str:
    body = LAYOUTS[stub.layout](stub)
    head = f"<meta charset='utf-8'><style>{STYLE}</style>"
    return f"<!doctype html><html><head>{head}</head><body>{body}</body></html>"


# ---------------------------------------------------------------- rendering


def render(stub: Stub) -> bytes:
    """The document's bytes. Imports WeasyPrint and Pillow only when called."""
    import weasyprint

    pdf: bytes = weasyprint.HTML(string=render_html(stub)).write_pdf()
    if stub.output == "text_pdf":
        return pdf
    image = _rasterize(pdf)
    if stub.output == "png":
        return _encode(image, "PNG")
    noisy = _scan(image, stub)
    if stub.output == "noisy_png":
        return _encode(noisy, "PNG")
    if stub.output == "noisy_jpeg":
        return _encode(noisy, "JPEG", quality=82)
    return _encode(noisy, "PDF", resolution=float(RASTER_DPI))


def _rasterize(pdf: bytes) -> Any:
    import pypdfium2

    document = pypdfium2.PdfDocument(pdf)
    try:
        return document[0].render(scale=RASTER_DPI / 72).to_pil().convert("L")
    finally:
        document.close()


def _scan(image: Any, stub: Stub) -> Any:
    """Speckle, a little blur and a slight rotation, like a phone scan."""
    from PIL import Image, ImageFilter

    rng = random.Random(stub.noise_seed)  # noqa: S311 (reproducible synthetic noise)
    page = image.copy()
    pixels = page.load()
    width, height = page.size
    for _ in range(width * height // 400):
        x, y = rng.randrange(width), rng.randrange(height)
        pixels[x, y] = rng.randint(90, 200)
    page = page.filter(ImageFilter.GaussianBlur(radius=0.6))
    return page.rotate(stub.rotation, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=255)


def _encode(image: Any, format: str, **options: Any) -> bytes:
    out = io.BytesIO()
    image.save(out, format=format, optimize=format != "PDF", **options)
    return out.getvalue()


@dataclass(frozen=True)
class Fixture:
    """A committed stub: its labels and its document bytes."""

    labels: dict[str, Any]
    data: bytes


def load_fixtures(directory: Path = DEFAULT_DIR) -> list[Fixture]:
    fixtures = []
    for path in sorted(directory.glob("*.json")):
        labels = json.loads(path.read_text())
        fixtures.append(Fixture(labels=labels, data=(directory / labels["file"]).read_bytes()))
    return fixtures


def write(directory: Path = DEFAULT_DIR, seed: int = SEED) -> list[Path]:
    directory.mkdir(parents=True, exist_ok=True)
    written = []
    for stub in generate(seed):
        document = directory / stub.filename
        document.write_bytes(render(stub))
        labels = directory / f"{stub.id}.json"
        labels.write_text(json.dumps(stub.labels(), indent=2, sort_keys=True) + "\n")
        written += [document, labels]
    return written


if __name__ == "__main__":
    for path in write():
        sys.stdout.write(f"{path}\n")
