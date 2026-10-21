# Feature specs

Every feature starts here, before code. A spec states what the feature must do precisely enough that its tests can be written from it alone, and an agent or a teammate can build it without guessing. When requirements change, the spec changes first, in the same pull request as the code.

## File names

`NNN-slug.md`, numbered in the order specs are written: `001-data-model.md`, `006-401k-match.md`. Numbers are never reused.

## Sections

Every spec has these sections, in this order. A section that does not apply says so in one line rather than disappearing.

| Section | What it holds |
|---|---|
| **Goal** | One paragraph: what the feature does for the user and where it lives in the code. |
| **Inputs** | Every input with its type and valid range. Money is integer cents (`Cents`, named `*_cents`), percentages are `Decimal`, dates are ISO dates, timestamps are UTC. |
| **Outputs** | Every output with its type and meaning. |
| **Rules** | Numbered, each one testable on its own. Rounding, boundaries and precedence are spelled out, not implied. |
| **Hand-worked examples** | A table where each row is one named test. Show the arithmetic for each row below the table, so a reviewer can check it without running code. Use real, cited constants; if a figure cannot be verified, the row says "pending verification" and the test is marked `xfail` until it is. |
| **Edge cases** | Inputs at boundaries, empty inputs, invalid inputs and what each returns. |
| **Out of scope** | What the feature deliberately does not do, so nobody adds it by accident. |
| **Status** | One of Draft, Ready, Implemented, Superseded, with the milestone and any examples still pending. Put it at the top of the file. |

Specs may add an **Open questions** section for decisions not yet made. A spec with open questions that affect a rule or an example stays Draft.

## How specs become tests

- Each hand-worked example row becomes one test whose name is the row's test name, in the test file the spec names.
- Each numbered rule that is not covered by an example gets its own test or a property test.
- External constants (IRS limits, brackets, Plaid conventions) are cited with a URL in the spec, and the constants file in code notes the same source.

## Index

| Spec | Status |
|---|---|
| [001 Data model](001-data-model.md) | Draft, M0 |
| [002 Sync pipeline, Plaid, webhooks and jobs](002-sync-pipeline.md) | Implemented, M1 |
| [003 Categorization, the LLM gateway and transaction routes](003-categorization.md) | Implemented, M1 |
| [006 401(k) match calculator](006-401k-match.md) | Draft, M3 |
