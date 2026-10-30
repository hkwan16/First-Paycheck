# 018: Decisions as four steps

Status: Implemented, M10 (web only). Rules 11-17, the side nav on a phone (issue 155), and rule 6a, a footer link landing at the top (issue 172): Implemented, Hardening (web only).

## Goal

The Decisions screen put four calculators on one page, two by two, with every control of every card in view at once; people found it cluttered. This spec splits it into four steps, one page per calculator, in the mockup's order (emergency fund, 401(k), health plan, W-4), and gives the side nav four sub-items under "Decisions", so a person works through one decision at a time and can still see, from anywhere, which ones are saved. On a phone the nav with its sub-items filled about 500px of a 390x844 screen above the page's heading, so a person saw navigation and not the decision; under 780px the nav now collapses to one control that names where the person is and opens the full list (rules 11-17). Nothing about a calculator changes: each card moves to its own page as it is. No API route or schema changes; every number still comes from the API. Code: `web/src/lib/decision-steps.ts` (order, slugs, neighbors), the route builders in `web/src/lib/routes.ts`, `web/src/components/screens/decisions/DecisionStepScreen.tsx`, `web/src/app/(app)/setup/decisions/<slug>/page.tsx`, `web/src/components/chrome/SideNav.tsx` (with `AppSideNav.tsx`), `web/src/lib/setup-progress.ts` and the redirect in `web/src/proxy.ts`.

## Inputs

| Input | Type | Meaning |
|---|---|---|
| The step | one of the four calculators (`CalculatorId`: `emergency_fund`, `401k_match`, `health_plan`, `w4`) | Which page, from its route. |
| Live calculators | list of `CalculatorId` (`features.calculators`, from `NEXT_PUBLIC_FEATURES`) | Calculators on in this build; the rest are "After alpha". |
| `GET /decisions` | `DecisionList` (spec 007) | Which calculators have a saved decision; read already by the badge and by `useSetupProgress`. No new read. |

## Outputs

| Route | Page title (tab) | Heading (h1) | Card |
|---|---|---|---|
| `/setup/decisions/emergency-fund` | Emergency fund | How much to keep for emergencies | `EmergencyFundCard` |
| `/setup/decisions/401k` | 401(k) match | How much to put in your 401(k) | `Match401kCard` |
| `/setup/decisions/health-plan` | Health plan | Which health plan to choose | `HealthPlanCard` |
| `/setup/decisions/w4` | W-4 | What to put on your W-4 | `W4Card` |

`/setup/decisions` has no page of its own: the proxy answers it with a 307 to the entry step (rule 3).

The side nav's "Decisions" item gets a nested list of four sub-items, labeled "Emergency fund", "401(k) match", "Health plan" and "W-4", each linking to its step.

## Rules

### Routes

1. **One route per calculator**, with the short, stable slugs in the table above. A slug is part of the URL people bookmark and other screens link to: renaming one is a breaking change. The order is fixed: emergency fund, 401(k), health plan, W-4 (the mockup's order). The W-4 reads the saved 401(k) and health plan decisions (spec 014), so it comes last.
2. **Each step page renders exactly one card**, the calculator's, inside its `CardErrorBoundary`, or the muted "After alpha" `PlaceholderCard` when the calculator is not live. The title row, the card and the footer share one column at most `48rem` (`max-w-3xl`) wide, so a single card never stretches across a wide screen.
3. **`/setup/decisions` redirects in the proxy** (307, temporary because the target depends on the build's flags) to the entry step: the first live calculator in step order, or the first step when none is live. It redirects after the sign-in check, so a signed-out request still goes to `/sign-in?next=/setup/decisions` and comes back through the redirect. The redirect is in the proxy, not in a page, because `next dev` reports a redirect thrown while rendering (web/CLAUDE.md, Auth).
4. **Every link into Decisions goes to a step route**, built in `lib/routes.ts`, never with a fragment:
   - **One calculator's step** (`decisionStepRoute(calculatorId)`, `decisionKindRoute(calculatorKind)`), whether or not it is live: the Plan's "Still to decide", the Plan calendar's event badges, a check-in finding's "Affects", the W-4 card's "Save your 401(k) decision" and "Choose your health plan", Why's "Re-run the calculator" (the decision's own calculator), and the Spending diagram's "See what a 401(k) match is worth".
   - **The health plan step when it is live, else the entry step** (`decisionRouteFor('health_plan')`): a benefits summary's way on, because its plans are compared there. That is Confirm's "Continue to decisions" for a confirmed summary, its "Go to decisions" for one nothing could be read from, and the Link documents' "Go to decisions" for that one. In the alpha the health plan is a placeholder, so these go to the 401(k), whose plan details take the match.
   - **The entry step** (`firstDecisionRoute()`, rule 3's target): Spending's "Use these numbers in decisions", the Why index's and the Plan's "Go to decisions" when nothing is saved, and the side nav's "Decisions".
   - **The last live step** (`lastDecisionRoute()`): the Plan's "Back to decisions", the step whose next leads to the Plan.

### Each step page

5. **Title**: an eyebrow row with "Decision n of 4" (the step's place in the order, counting every calculator, live or not) and, once `GET /decisions` has answered, the "n of 4 saved" badge (the number of calculators in `GET /decisions`, `items.length`, of the 4); the h1 from the table; and, for a live calculator only, the lead "Move the controls to try what-ifs. Every number comes from the calculator, not the AI. Saving keeps a versioned record and adds it to your plan." A placeholder has no controls, so its card says what it will decide instead. The tab title is the table's page title.
6. **Footer**: Back goes to the previous live step, or to `/setup/spending` before the first live one; next goes to the next live step, or to `/plan` after the last live one. Steps that are not live are skipped, so the alpha (`calculators=401k_match`) walks Spending, 401(k), Plan as before. Labels: "Back to {name}" and "Next: {name}", where the names are "emergency fund", "401(k) match", "health plan" and "W-4"; Back to Spending is "Back"; next to the Plan is "See your plan" (today's label). A step that is not live has the same neighbors as if it were: the live steps around its place in the order.
6a. **A footer link lands at the top of the next page** (issue 172), at every width, for every `StepFooter` link (the setup screens' too). Next's App Router scrolls only when the changed segment's top edge is out of view. Following a footer link at the bottom of a long step, the browser first clamps the scroll offset to the new page, which is still short while its cards load; the new page's top edge is then in view, so Next leaves it, 155px down on a 390x844 phone with the collapsed nav button (rule 11) under the sticky header. A step change is a new page and starts at the top: the link turns Next's scroll off and asks (`onNavigate`, `lib/land-at-top.ts`), and the new page's `HydrationMarker`, which every page renders, scrolls to the top as its content commits, before it is painted. Back and forward, reloads and every other link keep the browser's and Next's scrolling. A `scroll-padding-top` the size of the header was weighed and set aside: Next would then scroll this case, but a clamp that leaves the page's top edge below the header would still land part way down. `e2e/decisions.spec.ts` follows a Next and a Back link at 390x844 and checks the page is at 0 with the nav button clear of the header; the sample screens cannot show it, since their footers lead out of the sample layout and the whole page remounts.

### Side nav

7. **Sub-items**: "Decisions" holds a nested list of the four steps in step order, indented under it. Each is a link at least 44px tall with a small marker (a dot, or a check once done) and its label. The current step's link has `aria-current="page"`; nothing else on a step page does (the "Decisions" link is the section, not the page).
8. **Done marks**: a sub-item is done when its calculator is live and has a saved decision (`setupProgress`, from the `savedDecisionCalculators` and `liveCalculators` it already reads; no new API call). "Decisions" itself is done when every live calculator is saved (unchanged). A done item says ", done" to screen readers, like the steps.
9. **Not live**: a calculator off in `features.calculators` is still a sub-item, still a link to its step (whose page shows the placeholder), drawn muted with a visible "After alpha" after its label; its accessible name ends ", After alpha". It is never marked done.
10. **"Decisions" links to the entry step** (rule 3's target), not to `/setup/decisions`, so following it costs no redirect.
### The side nav on a phone (issue 155)

11. **Under 780px the nav collapses to one control** at the top of the page, above the page's title, that names where the person is and opens the full nav list. The breakpoint stays 780px (the `nav` breakpoint token). At 780px and wider nothing changes: the control is not displayed (so it is neither seen nor reached by Tab) and the list is always shown, as before. On a 390x844 phone the h1 of every app screen is within the first screenful.
12. **A disclosure, not a sheet.** The control is a `<button>` with `aria-expanded` and `aria-controls` naming the list, and the open list sits in the page flow right under it, pushing the page down. That is the accessible choice with the least to get wrong: focus stays on the button when the list opens, Tab goes from the button straight into the list in reading order, the page around it stays usable, and nothing is covered. A modal sheet would need a focus trap, a backdrop, a scroll lock, `inert` on the rest of the page and a close button of its own, and it would hide the page the person is on to show them navigation, for no gain on a list of eleven links. The control and the list are in the one `<nav aria-label="Setup steps">`, so on a phone the landmark is still there, with the button first in it.
13. **Closed**, the control shows the current item's marker (its `NavStep`: the step number or glyph, the small dot for a decision step, a check once done), its label, with its section first for a decision step ("Decisions: 401(k) match"), and under it how far through setup the person is: "n of 4 setup steps done", counting the four setup steps (Accounts and documents, Confirm pay stub, Spending map, Decisions) that the list marks done, from the same `setupProgress` (`setupStepsDone`). With no current item (a page the nav does not list, or the layout's fallback before the URL is read) the label is "Setup steps" with a neutral glyph. A small arrow at the end, the account menu's, points down while closed and up while open. The accessible name is the visible text with ", done" after a done item's label and a comma before the progress: "Decisions: 401(k) match, done, 3 of 4 setup steps done". The control spans the content width and is at least 44px tall.
14. **Open**, the list is the desktop list: one list in two presentations, never a second copy for phones. The two groups, the four decision steps indented under Decisions behind their hairline, every done mark, `aria-current="page"` on the current item, the muted "After alpha" steps and every 44px target are as rules 7-9 say. It stacks one item per row, as on desktop: the wrapping chip row it replaces is gone, so every label reads in full.
15. **It closes** when the person presses the control again, presses Escape while focus is in the nav (focus returns to the control), or chooses a link in the list, and whenever the page changes some other way (a link in the page, the footer, Back): an open list belongs to the page it was opened on. Every page load starts closed. A click elsewhere does not close it, since it covers nothing.
16. **Motion and transparency**: the only movement is that arrow turning, over `--duration-fast`, which reduced motion sets to zero; the list appears and disappears at once, with no animation. Nothing in the control is translucent, so reduced transparency changes nothing.
17. **The keyboard path on a phone**: Tab reaches the control right after the header's controls; Enter or Space opens it; Tab then goes through the list in order (the four decision steps right after "Decisions", before "Why this decision") and on into the page. The smoke spec's Tab walk presses Enter on the control when it reaches it and walks the list too, so every nav link stays reachable at 390px and is checked for its focus ring.

## Hand-worked examples

### Steps (`web/src/lib/decision-steps.test.ts`, `web/src/lib/routes.test.ts`)

| Test | Live calculators | Step | Back | Next |
|---|---|---|---|---|
| `every live: the first step goes back to Spending` | all four | emergency fund | `/setup/spending` "Back" | `/setup/decisions/401k` "Next: 401(k) match" |
| `every live: a middle step` | all four | health plan | `/setup/decisions/401k` "Back to 401(k) match" | `/setup/decisions/w4` "Next: W-4" |
| `every live: the last step goes on to the plan` | all four | W-4 | `/setup/decisions/health-plan` "Back to health plan" | `/plan` "See your plan" |
| `the alpha: the 401(k) is the only step` | `401k_match` | 401(k) | `/setup/spending` "Back" | `/plan` "See your plan" |
| `the alpha: a placeholder step has the live steps around it` | `401k_match` | health plan | `/setup/decisions/401k` "Back to 401(k) match" | `/plan` "See your plan" |
| `skips a step in the middle that is not live` | `emergency_fund`, `w4` | emergency fund | `/setup/spending` "Back" | `/setup/decisions/w4` "Next: W-4" |

| Test | Live calculators | Entry (`firstDecisionRoute`) | Last (`lastDecisionRoute`) |
|---|---|---|---|
| `every live` | all four | `/setup/decisions/emergency-fund` | `/setup/decisions/w4` |
| `the alpha` | `401k_match` | `/setup/decisions/401k` | `/setup/decisions/401k` |
| `none live` | none | `/setup/decisions/emergency-fund` | `/setup/decisions/w4` |

### Done marks (`web/src/lib/setup-progress.test.ts`)

| Test | Live | Saved | Sub-items done | Decisions done |
|---|---|---|---|---|
| `marks each saved live calculator's step` | all four | `401k_match`, `w4` | 401(k), W-4 | no |
| `never marks a step that is not live` | `401k_match` | `w4` | none | no |
| `all live saved` | `401k_match` | `401k_match` | 401(k) | yes |

### The phone control (`web/src/components/chrome/SideNav.test.tsx`, `web/src/lib/setup-progress.test.ts`)

| Test | Current | Done | The closed control's accessible name |
|---|---|---|---|
| `names a setup step and the setup progress` | `spending` | `link`, `confirm` | "Spending map, 2 of 4 setup steps done" |
| `names a decision step after its section, with its done mark` | `401k_match` | `link`, `confirm`, `spending`, `401k_match` | "Decisions: 401(k) match, done, 3 of 4 setup steps done" |
| `names a plan screen` | `checkIn` | `link`, `confirm`, `spending`, `decisions`, `plan` | "Monthly check-in, 4 of 4 setup steps done" |
| `names the nav itself with no current item` | none | none | "Setup steps, 0 of 4 setup steps done" |

`setupStepsDone` counts only the four setup steps: `{ link, confirm, spending, decisions, plan, '401k_match', w4 }` all true is 4, and `{ confirm, plan, w4 }` is 1.

| Test | Steps | Result |
|---|---|---|
| `opens the list in place and closes it again` | press the control, then press it again | `aria-expanded` true, the list (its `aria-controls`) shown; then false, the list hidden under 780px |
| `closes on Escape and gives focus back to the control` | open, Tab into the list, Escape | closed, focus on the control |
| `closes when a link in the list is chosen` | open, click "Spending map" | closed |
| `closes when the page changes` | open, rerender with a new `pathname` | closed |

### Redirect (`web/src/proxy.test.ts`)

| Test | Request | Response |
|---|---|---|
| `sends /setup/decisions to the first live step` | signed in, `/setup/decisions` | 307 to `/setup/decisions/<first live slug>` |
| `signs in first` | signed out, `/setup/decisions` | 307 to `/sign-in?next=/setup/decisions` |
| `leaves a step alone` | signed in, `/setup/decisions/w4` | passes through |

## Edge cases

- An unknown slug (`/setup/decisions/roth`) is Next's 404; it is still behind the sign-in guard (`/setup` prefix).
- An old link with a fragment (`/setup/decisions#k401-title`): the fragment never reaches the server, so it redirects to the entry step and the browser keeps the fragment, which matches no element there. The app no longer makes such links (rule 4).
- No calculator live: the entry is the first step and every step is a placeholder; Back goes to Spending and next to the Plan on every step.
- A saved decision for a calculator that is not live: its sub-item is muted and not done, and its page shows the placeholder; the "n of 4 saved" badge still counts it, as `GET /decisions` lists it (unchanged from the one-page screen).
- A card that throws while rendering: its boundary shows the card's frame and notice, and the page's title, badge and footer still work, so the person can move on to the next step.
- `GET /decisions` fails or is loading: no badge and no done marks, as before.
- The done marks are loading: the closed control counts the marks the list shows, so it says "0 of 4 setup steps done" until they arrive, as the list shows no checks until then; the line is always there, so nothing below it moves when the count changes.
- A window resized across 780px while the list is open: at 780px and wider the list shows as always and the control is not displayed; back under 780px the list is still open.
- An item whose label wraps (a narrow phone): the control grows to fit and stays at least 44px; nothing is cut off.

## Out of scope

- An overview page at `/setup/decisions` listing the four with their saved state. The side nav already shows all four with their done marks on every screen, each step shows "n of 4 saved", and the Plan lists every saved decision with its figures; an overview would be one more page between the person and the first decision, with nothing to decide on it.
- Sending a person to their first unsaved step. The proxy has no session data to know it, and reading it in the page would mean a client redirect after render. The nav's done marks show which ones are left.
- Changing any calculator card, the API, or the mockup.
