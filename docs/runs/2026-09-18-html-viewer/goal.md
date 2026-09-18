# Run goal — HTML document viewing in Conduit

**Date:** 2026-09-18
**Conductor tier:** Opus 5 (1M) — fixed for the run, never auto-escalated.
**Mode:** fully autonomous (`auto mode fully`). No interactive question tools. Every
would-be approval is recorded as an assumption in `decisions.md`.

## User-visible outcome

An `.html` file opened in Conduit can be **viewed rendered**, not only edited as source
— the same affordance Markdown files already have. Reachable from every place a file
can be opened: Explorer context menu, double-click, command palette, omni search,
editor tab / breadcrumb, links, drag & drop, and a source ⇄ rendered toggle inside the
open document.

## Mandate

**Scope budget.** Ship HTML viewing end-to-end, fully specified, built, reviewed,
runtime-QA'd, committed and merged with a green gate on the merged tree. When the
queue empties before the scope is spent, run a discovery pass over adjacent viewer
surfaces (Phase 6 refill) rather than declaring done.

## Phase 0 gate commands

- `npm run verify` — format-check + lint + dead-code + duplication + typecheck + unit
  tests + security (SAST / dep-audit / secrets). The gate. Exit code read directly,
  never through a pipe or pager.
- `node test/e2e/run-smoke.mjs [scenario]` — the end-to-end harness that drives the
  **real built Electron app** (hidden, `CONDUIT_E2E=1`). This is the runtime-observation
  capability the loop requires; it exists already.
- `npm run shots` — theme screenshot capture, for visual QA.

## Waivers

None recorded at kickoff.
