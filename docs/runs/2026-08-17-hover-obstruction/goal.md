# Run goal — hover overlays must never obstruct their own trigger

**Date:** 2026-08-17 **Conductor:** Opus 5 (1M context), fixed for the run.
**Mode:** in-session autonomous. No human available — every decision is recorded, none asked.

## User request (verbatim)

> There are certain bugs in the app, such as when I press Control F and a search box opens inside
> a code editor. I want to cancel or close that search box, right? There's an X button. When I
> hover over the X button, some sort of a popover pops up and blocks my cursor so I close that.
> Just make sure that that class of issues across the app doesn't exist anywhere else.

Follow-up: *"I won't be here, so you're on your own. Investigate and fix."*

## The invariant (conductor's call)

**A hover-triggered overlay must never take the pointer away from the control that triggered it.**

Concretely, for every hover-triggered floating element (tooltip / hovercard / label):
1. It is **not hit-testable** — `pointer-events: none` on the overlay *and every wrapper of it*.
2. Therefore `document.elementFromPoint(centre of trigger)` still resolves to the **trigger**
   while the overlay is showing.
3. Therefore no hover-flicker loop is possible (pointer enters overlay → leaves trigger →
   overlay hides → trigger re-hovered → overlay returns).

Interactive popovers (context menus, dropdowns, Monaco's **content** hovers with links you can
click and scroll) are explicitly **out of scope** — they are supposed to take the pointer. The
distinction is: does the floating thing exist to be *read*, or to be *used*?

## Phase 0 — grounding (already met, no `solidify-repo` pass needed)

| Gate | Command | Status |
|---|---|---|
| lint/typecheck/tests/dead-code/security | `npm run verify` | green on `main` at v0.31.0 |
| real-app end-to-end | `node test/e2e/run-smoke.mjs <name>` | exists |
| CSS-invariant guard (things no e2e can catch) | `test/unit/drag-region.test.ts` | established precedent to copy |

## Run constraints (standing, from the user)

- e2e **one scenario at a time**; never the full suite as a spot check.
- Never two `npm run verify` at once.
- Lanes serialized; only the conductor runs runtime gates.

## Scope decision (recorded, not asked)

`fix` = code fixed, verified, committed, merged to `main`. **No release.** The last two releases
were each cut on an explicit "ship it"; publishing to GitHub is outward-facing and the user is not
here to approve it. `main` will be left committed and **unpushed**, stated plainly in the report.
