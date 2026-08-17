# Run goal — selection-aware context menus

**Date:** 2026-08-16
**Conductor model:** Opus 5 (1M context) — fixed for the run.
**Mode:** in-session autonomous loop (no human mid-run).

## User request (verbatim)

> There is a series of actions around this application that require selecting multiple things and
> then right-clicking on them. For example if in the File Explorer I want to delete multiple files,
> what I normally would do is that I would select multiple files and then right-click on them and
> then delete them. Right now that doesn't work in our application. I think in general selecting a
> couple of things across the application and then right-clicking on them only affects the target of
> the right click. Just make sure that behavior is correct across all the features that we have in
> this app.

## The invariant to establish (conductor's architecture call)

One OS-standard rule, applied to **every** surface that has both a multi-selection and a context
menu:

1. **Right-click on an item that IS in the current selection** → the selection is preserved and the
   menu's actions apply to the **whole selection**. Labels reflect the count ("Delete 3 items").
2. **Right-click on an item that is NOT in the current selection** → the selection **collapses to
   that item** first, then the menu applies to it alone.
3. **Right-click on empty space / container chrome** → the container menu; selection untouched.
4. A surface with **no** multi-select is unaffected (single target is already correct).

The decision in (1)/(2) is one pure, shared, unit-tested function — not re-implemented per surface.

## Non-goals

- Adding multi-select to surfaces that legitimately don't have it.
- New menu actions beyond the parallel bulk form of actions that already exist.
- Changing the canonical menu order/grouping (see `docs/specs/archive/2026-06-23-context-menu-consistency.md`).

## Phase 0 — grounding (done)

Repo already meets the bar; no `solidify-repo` pass needed.

| Gate | Command | Status |
|---|---|---|
| format/lint/typecheck/tests/dead-code/security | `npm run verify` | baseline run recorded in `progress.md` |
| real-app end-to-end (drives the built Electron app, observes real DOM + real FS) | `node test/e2e/run-smoke.mjs <name>` | exists; `explorer-multiselect`, `context-menu-order` are the extension points |
| visual capture | `npm run shots` | exists |

## Run constraints (user, mid-run 2026-08-16)

> "Be mindful of the CPU usage, don't spin up a million e2e tests at once"

- e2e runs **one scenario at a time**, filtered (`node test/e2e/run-smoke.mjs <name>`). Never the
  full suite as a casual check.
- Never two `npm run verify` processes at once — three concurrent ones already produced a false
  failure this run (`conduit-proposal-fs.test.ts` blew its 5000 ms timeout; passes in 68 ms alone).
- Lanes are **serialized**, not fanned out into parallel worktrees. Only the conductor runs the
  runtime gates.
