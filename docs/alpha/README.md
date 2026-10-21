# First Paycheck: Alpha Release and Task Backlog

Due Thursday, November 5, 2026. This document follows the three sections of the [alpha brief](../alpha-brief.md). Sections marked TODO are filled in M4 from production.

## Early working demo

### What the alpha does

TODO (M4): one paragraph describing the alpha for a non-technical reader, then the path a user takes through it.

Production: TODO (Vercel URL). Recording (90 seconds): TODO.

### Functional and placeholder features

"Planned" is the alpha scope from the [build plan](../plan.md); "Actual" is filled from the production walkthrough.

| Feature | Planned for the alpha | Actual |
|---|---|---|
| Sign in (password, magic link, sign-up) | Functional | TODO |
| Link a Plaid sandbox bank and see synced transactions | Functional | TODO |
| Transactions categorized by rules then AI, with the source shown | Functional | TODO |
| Fix a category, which saves a rule | Functional | TODO |
| Upload a pay stub (PDF or image) with redaction before extraction | Functional | TODO |
| Review and confirm extracted fields, with the gross minus deductions equals net check | Functional | TODO |
| Spending summary tiles and transaction table | Functional | TODO |
| Spending cash-flow diagram (Sankey) | Not in the alpha (M5) | TODO |
| 401(k) match calculator | Functional | TODO |
| Save a decision, then save a new version that supersedes it | Functional | TODO |
| "Why" explanation verified against the calculator, with an IRS citation | Functional | TODO |
| Emergency fund, health plan and W-4 cards | Placeholder ("After alpha") | TODO |
| CSV import | Not in the alpha (M5) | TODO |
| Plan export and decision calendar | Not in the alpha (M9) | TODO |
| Monthly check-in | Not in the alpha (M8) | TODO |

### Screenshots

Screenshots live in [`screenshots/`](screenshots/) and are taken from production at 1280 px wide (and 390 px for phone).

TODO (M4): one screenshot per functional row above, each with a one-line caption.

## Documented backlog

The backlog is a GitHub Project. Every issue has a title, description, status, priority and assignee; the source of truth for issue text is [`docs/backlog.yaml`](../backlog.yaml), synced to GitHub by `scripts/sync_backlog.py`.

- Project board: TODO (link)
- Board screenshot: TODO (`screenshots/backlog.png`)

TODO (M4): two or three sentences on how the milestones are ordered and what is left after the alpha.

## Brief reflection on AI tool integration

Drawn from [`docs/ai-log.md`](../ai-log.md).

### Tools used

TODO (M4)

### How the tools changed the work

TODO (M4)

### Successes, challenges and surprises

TODO (M4)
