# Run report — 2026-06-22 wishlist (autonomous)

**Conductor:** Opus 4.8 (1M), in-session, serial. **Base:** `main` @ 0.7.3 (`9e25e16`).
**Mode:** unattended autonomous-build-loop. Ledger: `.autoloop/{goal,tasks,blockers}.md`.

## Summary

Three buildable wishlist items were specced earlier this session; this run built them to
verified-done (with one FULL feature delivered as its MVP slice). The three chat-ui–family
items were **already built** on the `chat-ui` branch and were deliberately **not** merged —
that's an irreversible integration decision left to the user (D-2).

Each feature: implemented (TDD where it fit) → unit tests → real-app e2e smoke (drives the
real Electron app) → full `npm run verify` green on the cumulative `main` tree → committed.
Serial-on-`main`, so every commit is verified against the integrated tree (continuous
integration, no separate unverified merge).

## Phase 0 — Ground (satisfied, not re-run)

Repo already hardened from prior runs: one-command `npm run verify`
(format/lint/dead-code/dup/typecheck/build/tests/security), and a real-artifact e2e harness
(`test/e2e/*.e2e.mjs` on `harness.mjs`) that launches the real app and captures DOM/state.
Both confirmed working this session. (`node_modules` was reinstalled — `pdfjs-dist` was
missing after the 0.5.1→0.7.2 fast-forward.)

## Shipped

| Feature | Tier | Commit | Evidence |
|---|---|---|---|
| Hide deleted folders from recent list | LITE | `911b108` | unit `repo-history.test.ts` (7, incl. `filterExistingRepos` ×3); e2e `recent-folders-prune.e2e.mjs` PASS (seeds present+missing folder; missing absent from `state.repos`); verify=0 |
| History ref filter → app's own dropdown | LITE | `76fe9dc` | e2e `git-ref-dropdown.e2e.mjs` PASS (no native `<select>`; dropdown opens; selecting a ref updates the label + closes); verify=0 |
| Terminal links: bare project-relative paths (**MVP**) | FULL→MVP | `31af2f2` | unit `terminal-links.test.ts` (38; 8 new incl. the exact `src/core/theme/accent.ts` case + ANSI/URL regression guards); e2e `terminal-path-links.e2e.mjs` PASS (host resolves matcher-produced relative path); verify=0 |

All user-facing; CHANGELOG `[Unreleased]` updated per feature. The two LITE specs were archived
(`docs/specs/archive/`), INDEX + wishlist updated.

## Deferred / blocked (see `.autoloop/blockers.md`)

- **chat-ui family** (agent-chat-ui, skill-installer, interactive-plans): already implemented on
  the `chat-ui` branch, unmerged. Not built — auto-merging a long-diverged branch unattended is
  an irreversible architecture call with guaranteed doc conflicts (INDEX/wishlist/CHANGELOG just
  changed on `main`). **User decision (D-2):** merge interactively + smoke-test, then release.
- **path-links v1** (the deferred half of the FULL spec): project-wide bare-**filename** suffix
  search + the >1-match **disambiguation dropdown** + a new host file-index `resolvePathToken`
  IPC. Deferred because its key UX (a dropdown from a click on a canvas terminal link) can't be
  honestly end-to-end smoke-tested unattended, and eager bare-filename matching needs human eyes
  on real terminal output to tune false positives. The MVP already delivers the user's literal
  ask. The spec already separates rule 1 (MVP, shipped) from rule 2 (v1, ready to build).

## needs-human-smoke

None. Every shipped item was verified in the real runtime.

## Notes / decisions made during autonomy

- **T3 right-sizing:** delivered the FULL spec's MVP slice (matcher broadening; no new IPC/UI —
  the existing `pathExists`+link wiring handles it), deferring v1. Honest scope over a large
  unverifiable build.
- Not pushed/released — left for the user to review the batch and decide on a release (the
  chat-ui D-2 question is best resolved first). `[Unreleased]` holds three entries ready to cut.
