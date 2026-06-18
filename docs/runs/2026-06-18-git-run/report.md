# Run report — git-run autonomous build (2026-06-18)

Autonomous build-loop run. Conductor model: Opus 4.8 (1M). Execution mode: delegated
(fresh-context subagents implement; conductor held architecture + taste + the ledger).
Integration branch: **`git-run`** (NOT merged to `main` — see Integration note).

## Scope & how it was chosen

`git worktree list` showed concurrent worktrees owning other wishlist work, so this run
deliberately took only the **un-owned** items:

- **In scope:** the 2026-06-18 papercuts/bugs (5 LITE) + the branch/worktree indicator (FULL).
- **Out of scope (owned elsewhere, untouched):** T2 terminal-scrollback persistence
  (checked out in worktree `conduit-wt-chatui` / branch `wt-t2-scrollback`); the spec-ready
  chat-UI / skill-installer / interactive-plans (already built on their own branches).

Phase 0 grounding was already satisfied by prior solidify runs: one-command gate
`npm run verify` (check + typecheck×2 + build + unit + fallow + audit + security) and a
real-app end-to-end observation harness (`node test/e2e/run-smoke.mjs <scenario>`, hidden
Electron). Baseline confirmed green before any change.

## Shipped (verified, committed on `git-run`)

| # | Feature | Tier | Commit(s) | Evidence |
|---|---|---|---|---|
| 1 | **md-toc**: outline scroll-spy keeps the clicked final section active when scrolled to the bottom of a long doc | LITE | `7b50a95` | unit (1397→ green) + new `test/e2e/md-toc-scrollspy.e2e.mjs`; real-app: final entry active at scroll-max |
| 2 | **quit-guard**: quit confirm never auto-dismisses — wedged-renderer 3s timeout now gated on a `quitDialogShown` ACK | LITE | `1f1c9f6` | smoke `quit-guard`: dialog stays open past 3.8s; explicit Cancel/Confirm still work |
| 3 | **mermaid**: zoom toolbar moved to top-right (matches image viewer) | LITE | `82eba7c` | real-app: `.mermaid-zoom__controls` computed `top:8/right:8` |
| 4 | **mermaid**: zoom overlay SVG scales vectorially (crisp at high zoom) — zoom via box width/height, dropped `will-change` | LITE | `a144535` | real-app: crisp at 244%, `will-change:auto`, width≈natural×zoom; pan/zoom/reset OK |
| 5 | **tabs**: tab size constant on overflow; thin (4px) overlaid scrollbar reserves no layout | LITE | `aeb786b` | real-app: tab box 91.22×44.00px **identical** overflowing vs not (ΔW=ΔH=0); new `test/e2e/tabbar-overflow.e2e.mjs` |
| 6 | **terminal git indicator (Slice A)**: read-only branch/worktree breadcrumb at the top of the terminal tab | FULL | `27fa46e` (+ leak-fix `e4e3cec`) | spec `docs/specs/2026-06-18-branch-worktree-indicator.md`; full verify green; e2e branch/detached/non-git all PASS; code-reviewed |

Final full `npm run verify` on the complete 7-commit tree: **green** — 1408 unit tests pass,
fallow no issues, audit below `--audit-level=high`, gitleaks no leaks, working tree clean.
Anti-gaming check: only **additions** to tests (3 new e2e files + extended quit-guard/md-toc
tests); **zero** gate-config files touched.

### Feature 6 detail (the marquee)

A `feature-spec` pass produced a rigorous FULL spec that splits the work:
- **Slice A (shipped):** host `src/git-info.ts` (`getGitInfo(cwd)` via `execFile('git', …)`,
  1500 ms timeout, process-level `gitAvailable` latch), a refresh seam (cwd-change +
  best-effort `fs.watch(HEAD)` + window-focus, 150 ms debounce, no polling) riding the
  existing `state` broadcast, a `GitIndicatorBar` in the E3 breadcrumb band (terminal-only),
  and a `showGitIndicator` setting. States: branch / detached (7-char SHA) / bare / unborn /
  worktree / mid-operation / dirty dot / non-git (hidden).
- **Independent code review** (conductor-dispatched) confirmed shell-safety, timeout-kill,
  persistence-strip, broadcast-only delivery, and the gitAvailable latch are all correct, and
  flagged **two `fs.watch` fd-leak races** (TOCTOU double-create; orphaned watcher when a
  session exits mid-interrogation). Both **fixed** in `e4e3cec` (`gitWatchInFlight` serialize
  guard + `gitTornDown` latch with post-await liveness recheck), re-verified green.

## Queued decision (surfaced for the user — not auto-landed)

- **[HIGH] D-1 — branch/worktree switcher (Slice B) switch-with-running-PTY semantics.**
  The read-only indicator (the primary ask — "no way to show where the user is") is done.
  The **switcher dropdown was intentionally NOT built**: it mutates git state (`git checkout`
  / worktree switch) from the UI while a PTY may be live, and the spec gates it behind a human
  safety sign-off. Spec's proposed safe default (which I **recommend approving**): *refuse the
  switch if the session is busy OR the working tree is dirty; otherwise run the checkout
  out-of-band via `execFile` (never typed into the shell) and refresh.* Build Slice B as a
  follow-up once you confirm. Details in `.autoloop/blockers.md` and spec §13.

## `needs-human-smoke`

None. Every shipped feature was observed in the real running artifact. Note: `run-smoke`
reports a `TIMEOUT` on the shared `app.close()` cleanup under the hidden CONDUIT_E2E launch on
this loaded machine — this is the **known smoke-env flakiness** (reproduces identically with
the pre-existing `cwd.e2e.mjs`), not a feature failure: every in-scenario assertion executed
and passed before the cleanup hang.

## Integration note

Work is committed on **`git-run`** and left there for the user to merge — `main` is checked
out in a concurrent worktree (`G:/awby/projects/conduit`), so merging from here would corrupt
another session's checkout. "Merged-tree verify" was satisfied by running the full
`npm run verify` green on the accumulated `git-run` tree. To land: from a safe checkout,
merge `git-run` into `main` and re-run `npm run verify`.

## Wishlist hygiene

The 5 papercuts + the branch/worktree item should be removed from `docs/wishlist.md` (they've
moved on — papercuts shipped here; the indicator is promoted to a spec). Left for the user to
prune alongside the merge, since the wishlist edit + merge are one logical step.
