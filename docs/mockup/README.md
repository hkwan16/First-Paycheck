# Mockup B: design reference

These files are the source of Mockup B, the clickable design that settles the look and interactions of the First Paycheck web app. The live version is the Design artifact at <https://claude.ai/artifact/K4UZ8HBNWQ8Ku1F783pm5v>; open it to click through the screens. The files here are copied verbatim from that artifact and are not edited in this repo.

The mockup is a reference, not code to ship. The React port in `web/` keeps its layout, tokens, components and interactions, and replaces its sample data and client-side formulas with API calls (see [What must change in the port](#what-must-change-in-the-port)).

## Files

| File | What it is |
|---|---|
| `canvas.json` | Canvas layout: board positions and sizes, screen order, and the two design notes (sample data, palette) |
| `*.dc.html` | One artboard per screen. Each is an HTML template with a `:root` block of CSS custom properties, the markup with `{{...}}` bindings, and a small script holding sample state and handlers |

The artboards load `./support.js`, the Design artifact's runtime, which is not part of this folder. Opened straight from disk they will not render their bindings; use the live artifact to see them working.

## Screens

Boards are 1280 px wide, in this order:

| # | File | Screen | What it shows |
|---|---|---|---|
| 0 | `Main.dc.html` | Sign in | Product promise, how AI is used, sign-in form |
| 1 | `Link.dc.html` | Link accounts and upload documents | Bank accounts with roles, documents with upload and redaction counts |
| 2 | `Confirm.dc.html` | Confirm pay stub fields | Extracted fields with confidence, edit and confirm, the redacted source pane, the gross minus deductions equals net check |
| 3 | `Spending.dc.html` | Spending map | Summary tiles, the cash-flow Sankey from gross pay to where each dollar went, the transaction table with category sources |
| 4 | `Decisions.dc.html` | Decisions | Four cards: emergency fund, 401(k) match, health plan, W-4 (federal only) |
| 5 | `Why.dc.html` | Why this decision | Concept, the user's numbers, what would change the answer, sources, the verified and fallback states |
| 6 | `Plan.dc.html` | Plan and calendar | One-page plan, decision calendar, decision history |
| 7 | `CheckIn.dc.html` | Monthly check-in | What changed, the month's cash flow against the plan, net worth |

The sample data (from the `sample` note in `canvas.json`) is invented: Acme Corp, $65,000 salary, semi-monthly pay with gross $2,708.33 and net $1,996.04 per paycheck, an employer match of 100% of the first 4% of salary, two Chase accounts and a Fidelity 401(k), and two invented health plans.

## Color meanings

Each hue means one kind of thing, everywhere. From the `palette` note in `canvas.json`:

| Color | Means |
|---|---|
| Blue | Primary actions, links, AI-labeled items, W-4, essentials |
| Coral | Brand mark and hero highlight, health plan, flexible spending, redaction counts, citations |
| Teal | Savings and the emergency fund |
| Plum | Income, 401(k), pay or deduction changes |
| Green | Only confirmed, verified, saved and on-plan states |
| Amber | Warnings and the explanation fallback |
| Red | Not applied or off plan |

Text on a tint uses the darker `-text` pair of its hue, each at 4.5:1 contrast or better. In the port, `web/src/lib/design/tone.ts` encodes these meanings as types (`Hue` for things, `Status` for states), so green is reachable only as `confirmed`.

## What must change in the port

The mockup takes shortcuts a product cannot. The port fixes each of these:

1. **No client-side formulas.** The artboards compute money in their scripts (for example the 401(k), health plan and W-4 math in `Decisions.dc.html` and the Sankey totals in `Spending.dc.html`). In the port every number comes from the API: `/calc/*` for calculator results, `/spending/summary` and `/cashflow` for totals and withholding lines. The client formats cents; it never sums or multiplies them.
2. **No hardcoded constants.** `Decisions.dc.html` embeds 2026 bracket tables, standard deductions and per-period premiums, and `Spending.dc.html` prints a fixed "1 px is about $13" scale. Tax constants live in `api/calc/data/<year>.json`; premiums come from confirmed pay stubs and benefits plans; the Sankey scale is computed by `layoutCashFlow` from the container width.
3. **The W-4 card reads saved decisions.** In the mockup the W-4 projection reads the live 401(k) slider on the same page. In the port it takes the saved 401(k) and health plan decisions as inputs, so the projection matches what the user committed to.
4. **Tokens, not hex.** The artboards repeat hex values inline (SVG strokes, some styles). The port defines them once as the `@theme` block in `web/src/app/globals.css` and refers to token names; an ESLint rule and a Vitest test reject raw hex outside the token file.
5. **Popover role.** The Sankey popover is `role="tooltip"`, but it holds interactive content and can be pinned. The port uses `role="group"` with `aria-controls` from the node, arrow-key movement between nodes, and Escape and outside-click close with focus restored.
6. **A real disabled continue button.** On Confirm, "Confirm and continue" is a link whose style changes when every field is confirmed. The port renders a `button` that is `disabled` until all fields are confirmed and the arithmetic check passes, and the server repeats the check as a 422.
7. **Derived nav marks.** The side navigation's done marks are written into each artboard. The port derives them from data in `web/src/lib/setup-progress.ts`.
8. **A stacked Sankey under 640 px.** The mockup scrolls the Sankey horizontally at any narrow width. The port lays it out at `max(880, containerWidth)` with horizontal scroll below 880 px, and under 640 px renders a stacked `Bar` variant that shows the same amounts.
